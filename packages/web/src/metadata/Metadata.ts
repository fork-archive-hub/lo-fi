import {
	applyPatch,
	assert,
	assignOid,
	ClientMessage,
	diffToPatches,
	DocumentBaseline,
	EventSubscriber,
	getOidRoot,
	HybridLogicalClockTimestampProvider,
	ObjectIdentifier,
	Operation,
	PatchCreator,
	StorageSchema,
	substituteRefsWithObjects,
} from '@lo-fi/common';
import { AckInfoStore } from './AckInfoStore.js';
import { BaselinesStore } from './BaselinesStore.js';
import {
	getAllFromObjectStores,
	getSizeOfObjectStore,
	storeRequestPromise,
} from '../idb.js';
import { LocalReplicaInfo, LocalReplicaStore } from './LocalReplicaStore.js';
import { MessageCreator } from './MessageCreator.js';
import { ClientOperation, OperationsStore } from './OperationsStore.js';
import { SchemaStore } from './SchemaStore.js';
import { Context } from '../context.js';

export interface ExportData {
	operations: Operation[];
	baselines: DocumentBaseline[];
	localReplica: LocalReplicaInfo;
	schema: StorageSchema;
}

export class Metadata extends EventSubscriber<{
	message: (message: ClientMessage) => void;
	rebase: (baselines: DocumentBaseline[]) => void;
}> {
	readonly operations;
	readonly baselines;
	readonly localReplica;
	readonly ackInfo;
	readonly messageCreator;
	readonly patchCreator;
	readonly schema;
	readonly time = new HybridLogicalClockTimestampProvider();

	private readonly disableRebasing: boolean = false;
	private _closing = false;

	private context: Omit<Context, 'documentDb'>;

	constructor({
		disableRebasing,
		context,
	}: {
		disableRebasing?: boolean;
		context: Omit<Context, 'documentDb'>;
	}) {
		super();
		this.context = context;
		this.schema = new SchemaStore(context.metaDb, context.schema.version);
		this.operations = new OperationsStore(this.db);
		this.baselines = new BaselinesStore(this.db);
		this.localReplica = new LocalReplicaStore(this.db);
		this.ackInfo = new AckInfoStore(this.db);
		this.messageCreator = new MessageCreator(this);
		this.patchCreator = new PatchCreator(() => this.now);
		if (disableRebasing) this.disableRebasing = disableRebasing;
	}

	private get db() {
		return this.context.metaDb;
	}

	private get log() {
		return this.context.log;
	}

	setContext = (context: Context) => {
		this.context = context;
	};

	get now() {
		return this.time.now(this.schema.currentVersion);
	}

	close = () => {
		this._closing = true;
	};

	/**
	 * Methods for accessing data
	 */

	createTransaction = (stores: ('operations' | 'baselines')[]) => {
		return this.db.transaction(stores, 'readwrite');
	};

	/**
	 * Gets the OID and every sub-object OID for a given document.
	 * Includes any sub-objects that are not referenced by the root object
	 * but still happen to be in storage.
	 */
	getAllDocumentRelatedOids = async (oid: ObjectIdentifier) => {
		const oids = new Set<ObjectIdentifier>();
		const documentOid = getOidRoot(oid);
		assert(documentOid === oid, 'Must be root document OID');
		oids.add(documentOid);
		// readwrite mode to block on other write transactions
		const transaction = this.db.transaction(
			['baselines', 'operations'],
			'readwrite',
		);
		await Promise.all([
			this.baselines.iterateOverAllForDocument(
				documentOid,
				(baseline) => {
					oids.add(baseline.oid);
				},
				{ transaction },
			),
			this.operations.iterateOverAllOperationsForDocument(
				documentOid,
				(patch) => {
					oids.add(patch.oid);
				},
				{ transaction },
			),
		]);

		return Array.from(oids);
	};

	getDocumentSnapshot = async (oid: ObjectIdentifier) => {
		const documentOid = getOidRoot(oid);
		assert(documentOid === oid, 'Must be root document OID');
		const transaction = this.db.transaction(
			['baselines', 'operations'],
			'readwrite',
		);
		const baselines = await this.baselines.getAllForDocument(documentOid, {
			transaction,
		});
		const objectMap = new Map<ObjectIdentifier, any>();
		for (const baseline of baselines) {
			if (baseline.snapshot) {
				assignOid(baseline.snapshot, baseline.oid);
			}
			objectMap.set(baseline.oid, baseline.snapshot);
		}
		await this.operations.iterateOverAllOperationsForDocument(
			documentOid,
			(op) => {
				const obj = objectMap.get(op.oid) || undefined;
				const newObj = applyPatch(obj, op.data);
				if (newObj) {
					assignOid(newObj, op.oid);
				}
				objectMap.set(op.oid, newObj);
			},
			{ transaction },
		);
		const root = objectMap.get(documentOid);
		if (root) {
			substituteRefsWithObjects(root, objectMap);
		}
		return root;
	};

	/**
	 * Methods for writing data
	 */

	/**
	 * Acks that we have seen a timestamp to the server
	 * and stores it as our local ackedLogicalTime if it's
	 * greater than our current ackedLogicalTime.
	 */
	ack = async (timestamp: string) => {
		const localReplicaInfo = await this.localReplica.get();
		this.emit('message', {
			type: 'ack',
			replicaId: localReplicaInfo.id,
			timestamp,
		});
		if (
			!localReplicaInfo.ackedLogicalTime ||
			timestamp > localReplicaInfo.ackedLogicalTime
		) {
			this.localReplica.update({ ackedLogicalTime: timestamp });
		}
	};

	/**
	 * Applies a patch to the document and stores it in the database.
	 * @returns the oldest local history timestamp
	 */
	insertLocalOperation = async (operations: Operation[]) => {
		if (operations.length === 0) return;
		// await this.rebaseLock;
		this.log(`Inserting ${operations.length} local operations`);

		// add local flag, in place.
		for (const operation of operations) {
			(operation as ClientOperation).isLocal = true;
		}
		await this.operations.addOperations(operations as ClientOperation[]);

		const message = await this.messageCreator.createOperation({ operations });
		this.emit('message', message);

		// we can now enqueue and check for rebase opportunities
		this.tryAutonomousRebase();
	};

	/**
	 * Inserts remote operations. This does not affect local history.
	 * @returns a list of affected document OIDs
	 */
	insertRemoteOperations = async (operations: Operation[]) => {
		if (operations.length === 0) return [];
		// await this.rebaseLock;
		this.log(`Inserting ${operations.length} remote operations`);

		const affectedDocumentOids = await this.operations.addOperations(
			operations.map((patch) => ({
				...patch,
				isLocal: false,
			})),
		);

		this.ack(operations[operations.length - 1].timestamp);

		return affectedDocumentOids;
	};

	insertRemoteBaselines = async (baselines: DocumentBaseline[]) => {
		if (baselines.length === 0) return [];
		this.log(`Inserting ${baselines.length} remote baselines`);

		await this.baselines.setAll(baselines);

		this.ack(baselines[baselines.length - 1].timestamp);

		const affectedOidSet = new Set<ObjectIdentifier>();
		baselines.forEach((baseline) => {
			affectedOidSet.add(getOidRoot(baseline.oid));
		});

		return Array.from(affectedOidSet);
	};

	updateLastSynced = async (timestamp: string) => {
		return this.localReplica.update({
			lastSyncedLogicalTime: timestamp,
		});
	};

	lastSyncedTimestamp = async () => {
		const localReplicaInfo = await this.localReplica.get();
		return localReplicaInfo.lastSyncedLogicalTime;
	};

	private tryAutonomousRebase = async () => {
		if (this.disableRebasing) return;

		const localReplicaInfo = await this.localReplica.get();
		if (localReplicaInfo.lastSyncedLogicalTime) return; // cannot autonomously rebase if we've synced
		// but if we have never synced... we can rebase everything!
		await this.runRebase(this.now);
	};

	/**
	 * Attempt to autonomously rebase local documents without server intervention.
	 * This can currently only happen for a client who has never synced before.
	 * The goal is to allow local-only clients to compress their history to exactly
	 * their undo stack.
	 */
	private runRebase = async (globalAckTimestamp: string) => {
		if (this._closing) return;

		// find all operations before the global ack
		let lastTimestamp;
		const toRebase = new Set<ObjectIdentifier>();
		const transaction = this.db.transaction(
			['baselines', 'operations'],
			'readwrite',
		);
		let operationCount = 0;
		await this.operations.iterateOverAllOperations(
			(patch) => {
				toRebase.add(patch.oid);
				lastTimestamp = patch.timestamp;
				operationCount++;
			},
			{
				before: globalAckTimestamp,
				transaction,
			},
		);

		if (!toRebase.size) {
			this.log('Cannot rebase, no operations prior to', globalAckTimestamp);
			return;
		}

		if (this._closing) {
			return;
		}

		// rebase each affected document
		let newBaselines = [];
		for (const oid of toRebase) {
			newBaselines.push(
				await this.rebase(
					oid,
					lastTimestamp || globalAckTimestamp,
					transaction,
				),
			);
		}
		this.emit('rebase', newBaselines);
	};

	rebase = async (
		oid: ObjectIdentifier,
		upTo: string,
		providedTx?: IDBTransaction,
	) => {
		// including replica Id for testing I guess
		const replicaId = (await this.localReplica.get()).id;

		this.log('[', replicaId, ']', 'Rebasing', oid, 'up to', upTo);
		const transaction =
			providedTx ||
			this.db.transaction(['operations', 'baselines'], 'readwrite');
		const baseline = await this.baselines.get(oid, { transaction });
		let current: any = baseline?.snapshot || undefined;
		let operationsApplied = 0;
		await this.operations.iterateOverAllOperationsForEntity(
			oid,
			(patch, store) => {
				// FIXME: this seems like the wrong place to do this
				// but it's here as a safety measure...
				if (!baseline || patch.timestamp > baseline.timestamp) {
					current = applyPatch(current, patch.data);
				}
				// delete all prior operations to the baseline
				operationsApplied++;
				store.delete(patch.oid_timestamp);
			},
			{
				to: upTo,
				transaction,
			},
		);
		if (current) {
			assignOid(current, oid);
		}
		const newBaseline = {
			oid,
			snapshot: current,
			timestamp: upTo,
		};
		if (newBaseline.snapshot) {
			await this.baselines.set(newBaseline, { transaction });
		} else {
			await this.baselines.delete(oid, { transaction });
		}

		this.log(
			'successfully rebased',
			oid,
			'up to',
			upTo,
			':',
			current,
			'and deleted',
			operationsApplied,
			'operations',
		);

		return newBaseline;
	};

	reset = async () => {
		await this.operations.reset();
		await this.baselines.reset();
		await this.localReplica.reset();
	};

	updateSchema = async (schema: StorageSchema, overrideConflict?: number) => {
		const storedSchema = await this.schema.get();
		if (storedSchema) {
			// version changes will be handled by migration routines in
			// the actual idb database loading code (see: initializeDatabases)

			// but this check determines if the schema has been changed without
			// a version change. if so, it will error.
			if (
				overrideConflict === storedSchema.version &&
				storedSchema.version === schema.version &&
				JSON.stringify(storedSchema) !== JSON.stringify(schema)
			) {
				console.error(
					`Schema mismatch for version ${schema.version}
					${JSON.stringify(storedSchema)}
					${JSON.stringify(schema)}`,
				);
				throw new Error(
					'Schema has changed without a version change! Any changes to your schema must be accompanied by a change in schema version and a migration routine.',
				);
			}
		}
		await this.schema.set(schema);
	};

	setGlobalAck = async (timestamp: string) => {
		await this.ackInfo.setGlobalAck(timestamp);
		if (!this.disableRebasing) {
			await this.runRebase(timestamp);
		}
	};

	export = async (): Promise<ExportData> => {
		const db = this.db;
		const [baselines, operations] = await getAllFromObjectStores(db, [
			'baselines',
			'operations',
		]);
		const localReplica = await this.localReplica.get();
		const schema = await this.schema.get();
		if (!schema) {
			throw new Error('Cannot export Client data before initializing');
		}
		return {
			operations,
			baselines,
			localReplica,
			schema,
		};
	};

	/**
	 * Resets local metadata and clears operation/baseline stores.
	 * DOES NOT add operations/baselines - this should be done
	 * through the normal higher level systems.
	 */
	resetFrom = async (data: ExportData) => {
		const db = this.db;
		const transaction = db.transaction(
			['baselines', 'operations', 'info'],
			'readwrite',
		);
		await storeRequestPromise(transaction.objectStore('baselines').clear());
		await storeRequestPromise(transaction.objectStore('operations').clear());
		await storeRequestPromise(transaction.objectStore('info').clear());
		await this.localReplica.update(
			{
				ackedLogicalTime: data.localReplica.ackedLogicalTime,
				lastSyncedLogicalTime: data.localReplica.lastSyncedLogicalTime,
			},
			{ transaction },
		);
	};

	stats = async () => {
		const db = this.db;
		const operationsSize = await getSizeOfObjectStore(db, 'operations');
		const baselinesSize = await getSizeOfObjectStore(db, 'baselines');

		return {
			operationsSize,
			baselinesSize,
		};
	};
}
