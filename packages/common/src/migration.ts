import {
	stableStringify,
	StorageCollectionSchema,
	StorageSchema,
	addFieldDefaults,
	StorageDocument,
} from './index.js';

export interface DroppedCollectionMigrationStrategy<
	Old extends StorageCollectionSchema<any, any, any>,
> {
	(old: Old): void;
}
export interface PreservedCollectionMigrationStrategy<
	Old extends StorageCollectionSchema<any, any, any>,
	New extends StorageCollectionSchema<any, any, any>,
> {
	(old: StorageDocument<Old>): StorageDocument<New>;
}

type MigrationStrategy<
	Old extends StorageCollectionSchema<any, any, any>,
	New extends StorageCollectionSchema<any, any, any>,
> =
	| DroppedCollectionMigrationStrategy<Old>
	| PreservedCollectionMigrationStrategy<Old, New>;

export type MigrationsKeyedOnCollection<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> =
	| PreservedCollectionMigrations<Old, New>
	| DroppedCollectionMigrations<Old, New>;

type NotInSchema<
	Name extends string | number | symbol,
	Schema extends StorageSchema<any>,
> = Name extends keyof Schema['collections'] ? never : Name;
type InSchema<
	Name extends string | number | symbol,
	Schema extends StorageSchema<any>,
> = Name extends keyof Schema['collections'] ? Name : never;

type NewCollections<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> = {
	[Key in keyof New['collections'] as NotInSchema<
		Key,
		Old
	>]: StorageCollectionSchema<any, any, any>;
};

type DroppedCollections<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> = {
	[Key in keyof Old['collections'] as NotInSchema<
		Key,
		New
	>]: StorageCollectionSchema<any, any, any>;
};

type PreservedCollections<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> = {
	[Key in keyof Old['collections'] as InSchema<
		Key,
		New
	>]: StorageCollectionSchema<any, any, any>;
};

type DroppedCollectionMigrations<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> = {
	[Key in keyof DroppedCollections<
		Old,
		New
	>]: DroppedCollectionMigrationStrategy<Old['collections'][Key]>;
};
type PreservedCollectionMigrations<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> = {
	[Key in keyof PreservedCollections<
		Old,
		New
	>]: PreservedCollectionMigrationStrategy<
		Old['collections'][Key],
		New['collections'][Key]
	>;
};

type StrategyFor<
	Key extends string,
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> = Key extends keyof New['collections']
	? PreservedCollectionMigrationStrategy<
			Old['collections'][Key],
			New['collections'][Key]
	  >
	: DroppedCollectionMigrationStrategy<Old['collections'][Key]>;

type MigrationRunner<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> = <Collection extends Extract<keyof Old['collections'], string>>(
	collection: Collection,
	strategy: StrategyFor<Collection, Old, New>,
) => Promise<void>;

export interface MigrationTools<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
> {
	migrate: MigrationRunner<Old, New>;
	identity: <T>(val: T) => T;
	withDefaults: (collectionName: string, value: any) => any;
	info: {
		changedCollections: string[];
		addedCollections: string[];
		removedCollections: string[];
	};
}

interface MigrationEngine {
	migrate: (
		collection: string,
		strategy: MigrationStrategy<any, any>,
	) => Promise<void>;
}

export function migrate<
	Old extends StorageSchema<any>,
	New extends StorageSchema<any>,
>(
	oldSchema: Old,
	newSchema: New,
	procedure: (tools: MigrationTools<Old, New>) => void | Promise<void>,
): Migration {
	// diff to determine changed collections
	const changedCollections: string[] = Object.keys(
		newSchema.collections,
	).filter(
		(key) =>
			stableStringify(oldSchema.collections[key]) !==
			stableStringify(newSchema.collections[key]),
	);
	const removedCollections: string[] = Object.keys(
		oldSchema.collections,
	).filter((key) => !newSchema.collections[key]);
	const addedCollections = Object.keys(newSchema.collections).filter(
		(key) => !oldSchema.collections[key],
	);

	const addedIndexes: Record<string, MigrationIndexDescription[]> = {};
	const removedIndexes: Record<string, MigrationIndexDescription[]> = {};
	for (const changed of changedCollections) {
		const oldIndexes = getIndexes(oldSchema.collections[changed]);
		const newIndexes = getIndexes(newSchema.collections[changed]);
		const added = newIndexes.filter(
			(index) => !oldIndexes.find((i) => i.name === index.name),
		);
		const removed = oldIndexes.filter(
			(index) => !newIndexes.find((i) => i.name === index.name),
		);
		if (added.length > 0) {
			addedIndexes[changed] = added;
		}
		if (removed.length > 0) {
			removedIndexes[changed] = removed;
		}
	}

	return {
		version: newSchema.version,
		migrate: async (engine: MigrationEngine) => {
			const migratedCollections: string[] = [];
			await procedure({
				migrate: async (collection, strategy) => {
					await engine.migrate(collection, strategy);
					migratedCollections.push(collection);
				},
				identity: (val: any) => val,
				withDefaults: (collectionName: string, val: any) => {
					return addFieldDefaults(newSchema.collections[collectionName], val);
				},
				info: {
					changedCollections,
					addedCollections,
					removedCollections,
				},
			});

			const unmigrated = changedCollections.filter(
				(collection) => !migratedCollections.includes(collection),
			);
			if (unmigrated.length > 0) {
				console.error('Unmigrated changed collections:', unmigrated);
			}
		},
		removedCollections,
		addedIndexes,
		removedIndexes,
		allCollections: Object.keys(newSchema.collections),
		changedCollections,
		addedCollections,
		oldSchema,
		newSchema,
	};
}

export interface MigrationIndexDescription {
	name: string;
	multiEntry: boolean;
	synthetic: boolean;
	compound: boolean;
}

export interface Migration {
	version: number;
	oldSchema: StorageSchema<any>;
	newSchema: StorageSchema<any>;
	migrate: (engine: MigrationEngine) => Promise<void>;
	addedCollections: string[];
	removedCollections: string[];
	allCollections: string[];
	changedCollections: string[];
	// new indexes mapped by collection name
	addedIndexes: Record<string, MigrationIndexDescription[]>;
	// removed indexes mapped by collection name
	removedIndexes: Record<string, MigrationIndexDescription[]>;
}

export function migrationRange(from: number, to: number) {
	return [...Array(to - from).keys()].map((i) => 1 + i + from);
}

function getIndexes<Coll extends StorageCollectionSchema<any, any, any>>(
	collection: Coll | undefined,
): MigrationIndexDescription[] {
	if (!collection) return [];
	const fields = Object.keys(collection.fields)
		.filter((key) => collection.fields[key].indexed)
		.map((key) => ({
			name: key,
			multiEntry: collection.fields[key].type === 'array',
			synthetic: false,
			compound: false,
		}));

	return [
		...fields,
		...Object.keys(collection.synthetics || {}).map((key) => ({
			name: key,
			multiEntry: collection.synthetics[key].type === 'array',
			synthetic: true,
			compound: false,
		})),
		...Object.keys(collection.compounds || {}).map((key) => ({
			name: key,
			multiEntry: collection.compounds[key].of.some(
				(fieldName: string) =>
					(collection.fields[fieldName] || collection.synthetics[fieldName])
						.type === 'array',
			),
			synthetic: false,
			compound: true,
		})),
	];
}

export function createDefaultMigration(
	schema: StorageSchema<any>,
	newSchema?: StorageSchema<any>,
): Migration {
	let oldSchema = newSchema
		? schema
		: {
				version: 0,
				collections: {},
		  };
	return migrate(
		oldSchema,
		newSchema || schema,
		async ({ migrate, withDefaults, info }) => {
			for (const collection of info.changedCollections) {
				// @ts-ignore indefinite type resolution
				await migrate(collection, (old) => withDefaults(collection, old));
			}
		},
	);
}
