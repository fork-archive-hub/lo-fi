import { DocumentBaseline } from './baseline.js';
import {
	assignOid,
	assignOidsToAllSubObjects,
	createRef,
	decomposeOid,
	ensureOid,
	getOid,
	getOidRoot,
	isOidKey,
	KeyPath,
	maybeGetOid,
	normalize,
	ObjectIdentifier,
	OID_KEY,
	removeOid,
} from './oids.js';
import { isObject, assert, cloneDeep, findLastIndex } from './utils.js';

// export type ObjectIdentifier<
// 	CollectionName extends string = string,
// 	DocumentId extends string = string,
// 	DocumentOid extends string = string,
// > =
// 	| `${CollectionName}/${DocumentId}:${DocumentOid}`
// 	| `${CollectionName}/${DocumentId}:${DocumentOid}#${string}`;

export type ObjectRef = {
	'@@type': 'ref';
	id: ObjectIdentifier;
};

export function isObjectRef(obj: any): obj is ObjectRef {
	return obj && typeof obj === 'object' && obj['@@type'] === 'ref';
}

export type Normalized<T> = {
	[key in keyof T]: T[key] extends Object ? ObjectRef : T[key];
};

// patches v2

export type PropertyName = string | number;
/**
 * List patches can target a particular child list or
 * nested lists. The first path item is the property path
 * of the first child list, any subsequent values are nested
 * list indices.
 */
export type PropertyValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| ObjectRef;

// all patches refer to a specific sub-object.
interface BaseOperationPatch {}

export interface OperationPatchInitialize extends BaseOperationPatch {
	op: 'initialize';
	value: any;
}
export interface OperationPatchSet extends BaseOperationPatch {
	op: 'set';
	name: PropertyName;
	value: PropertyValue;
}
export interface OperationPatchRemove extends BaseOperationPatch {
	op: 'remove';
	name: PropertyName;
}
export interface OperationPatchListPush extends BaseOperationPatch {
	op: 'list-push';
	value: PropertyValue;
}
export interface OperationPatchListInsert extends BaseOperationPatch {
	op: 'list-insert';
	index: number;
	value?: PropertyValue;
	values?: PropertyValue[];
}
export interface OperationPatchListDelete extends BaseOperationPatch {
	op: 'list-delete';
	index: number;
	count: number;
}
/**
 * Optimal for lists of object references. Moves
 * the selected item to the target index even if it
 * is not at the original index anymore.
 */
export interface OperationPatchListMoveByRef extends BaseOperationPatch {
	op: 'list-move-by-ref';
	value: ObjectRef;
	index: number;
}
/**
 * Suitable for any list move, whether object lists
 * or primitive lists.
 */
export interface OperationPatchListMoveByIndex extends BaseOperationPatch {
	op: 'list-move-by-index';
	from: number;
	to: number;
}
/**
 * Removes all instances of the value from
 * the list. Good for set behavior or removing
 * a specific item even if it changes index
 * from conflicts.
 */
export interface OperationPatchListRemove extends BaseOperationPatch {
	op: 'list-remove';
	value: PropertyValue;
	only?: 'first' | 'last';
}

export interface OperationPatchListAdd extends BaseOperationPatch {
	op: 'list-add';
	value: PropertyValue;
}

export interface OperationPatchDelete extends BaseOperationPatch {
	op: 'delete';
}

export type OperationPatch =
	| OperationPatchInitialize
	| OperationPatchSet
	| OperationPatchRemove
	| OperationPatchListPush
	| OperationPatchListInsert
	| OperationPatchListDelete
	| OperationPatchListMoveByRef
	| OperationPatchListMoveByIndex
	| OperationPatchListRemove
	| OperationPatchDelete
	| OperationPatchListAdd;

export type Operation = {
	oid: ObjectIdentifier;
	timestamp: string;
	data: OperationPatch;
};

export function diffToPatches<T extends { [key: string]: any } | any[]>(
	from: T,
	to: T,
	getNow: () => string,
	keyPath: KeyPath,
	createSubId?: () => string,
	patches: Operation[] = [],
	options: {
		/**
		 * If an object is merged with another and the new one does not
		 * have an OID assigned, assume it is the same identity as previous
		 */
		mergeUnknownObjects?: boolean;
		/**
		 * If an incoming value is not assigned on the new object, use the previous value.
		 * If false, undefined properties will erase the previous value.
		 */
		defaultUndefined?: boolean;
	} = {},
): Operation[] {
	const oid = getOid(from);

	function diffItems(key: string | number, value: any, oldValue: any) {
		if (!isObject(value)) {
			// for primitive fields, we can use plain sets and
			// do not need to recurse, of course
			if (value !== oldValue) {
				patches.push({
					oid,
					timestamp: getNow(),
					data: {
						op: 'set',
						name: key,
						value,
					},
				});
			}
		} else {
			const oldValueOid = maybeGetOid(oldValue);
			let valueOid;
			if (!options.mergeUnknownObjects) {
				valueOid = ensureOid(value, oid, key, createSubId);
			} else {
				// if merge unknown objects is requested, we copy the previous value's oid
				// to any mirrored new value if it doesn't have one assigned already.
				valueOid = maybeGetOid(value);
				if (!valueOid && oldValueOid) {
					assignOid(value, oldValueOid);
					valueOid = oldValueOid;
				} else {
					valueOid = ensureOid(value, oid, key, createSubId);
				}
			}

			if (oldValue === undefined || valueOid !== oldValueOid) {
				// first case: previous value exists but the OIDs are different,
				// meaning the object identity has changed
				// we add the whole new object and also update the reference on this
				// key of the parent to point to the new object
				initialToPatches(value, valueOid, getNow, createSubId, patches);
				patches.push({
					oid,
					timestamp: getNow(),
					data: {
						op: 'set',
						name: key,
						value: createRef(valueOid),
					},
				});
				// if there was an old value, we need to delete it altogether.
				if (oldValueOid !== undefined) {
					patches.push({
						oid: oldValueOid,
						timestamp: getNow(),
						data: {
							op: 'delete',
						},
					});
				}
			} else {
				// third case: OIDs are the same, meaning the identity is the same,
				// and we must diff the objects
				diffToPatches(
					oldValue,
					value,
					getNow,
					[...keyPath, key],
					createSubId,
					patches,
					options,
				);
			}
		}
	}

	if (Array.isArray(from) && Array.isArray(to)) {
		// diffing is more naive than native array operations.
		// we can only look at each element and decide if it should
		// be replaced or removed - no moves or pushes, etc.
		for (let i = 0; i < to.length; i++) {
			const value = to[i];
			const oldValue = from[i];
			diffItems(i, value, oldValue);
		}
		// remove any remaining items at the end of the array
		const deletedItemsAtEnd = from.length - to.length;
		if (deletedItemsAtEnd > 0) {
			// if sub-items were objects, we need to delete them all
			for (let i = to.length; i < from.length; i++) {
				const value = from[i];
				const valueOid = maybeGetOid(value);
				if (valueOid) {
					patches.push({
						oid: valueOid,
						timestamp: getNow(),
						data: {
							op: 'delete',
						},
					});
				}
			}
			// push the list-delete for the deleted items
			patches.push({
				oid,
				timestamp: getNow(),
				data: {
					op: 'list-delete',
					index: to.length,
					count: deletedItemsAtEnd,
				},
			});
		}
	} else if (Array.isArray(from) || Array.isArray(to)) {
		throw new Error('Cannot diff an array with an object');
	} else if (isObject(from) && isObject(to)) {
		const oldKeys = new Set(Object.keys(from));
		for (const [key, value] of Object.entries(to)) {
			if (value === undefined && options.defaultUndefined) continue;

			oldKeys.delete(key);

			if (isOidKey(key)) continue;

			const oldValue = from[key];

			diffItems(key, value, oldValue);
		}

		// this set now only contains keys which were not in the new object
		if (!options.defaultUndefined) {
			for (const key of oldKeys) {
				if (isOidKey(key)) continue;
				// push the delete for the property
				patches.push({
					oid,
					timestamp: getNow(),
					data: {
						op: 'remove',
						name: key,
					},
				});
			}
		}
	}

	return patches;
}

export function shallowDiffToPatches(
	from: any,
	to: any,
	getNow: () => string,
	patches: Operation[] = [],
) {
	const oid = getOid(from);

	function diffItems(key: string | number, value: any, oldValue: any) {
		if (!isObject(value) || isObjectRef(value)) {
			// for primitive fields, we can use plain sets and
			// do not need to recurse, of course
			if (value !== oldValue) {
				patches.push({
					oid,
					timestamp: getNow(),
					data: {
						op: 'set',
						name: key,
						value,
					},
				});
			}
		} else {
			throw new Error(
				'Shallow diff was given a nested object. This is an error in lo-fi!',
			);
		}
	}

	if (Array.isArray(from) && Array.isArray(to)) {
		// diffing is more naive than native array operations.
		// we can only look at each element and decide if it should
		// be replaced or removed - no moves or pushes, etc.
		for (let i = 0; i < to.length; i++) {
			const value = to[i];
			const oldValue = from[i];
			diffItems(i, value, oldValue);
		}
		// remove any remaining items at the end of the array
		const deletedItemsAtEnd = from.length - to.length;
		if (deletedItemsAtEnd > 0) {
			// push the list-delete for the deleted items
			patches.push({
				oid,
				timestamp: getNow(),
				data: {
					op: 'list-delete',
					index: to.length,
					count: deletedItemsAtEnd,
				},
			});
		}
	} else if (Array.isArray(from) || Array.isArray(to)) {
		throw new Error('Cannot diff an array with an object');
	} else if (isObject(from) && isObject(to)) {
		const oldKeys = new Set(Object.keys(from));
		for (const [key, value] of Object.entries(to)) {
			oldKeys.delete(key);

			if (isOidKey(key)) continue;

			const oldValue = from[key];

			diffItems(key, value, oldValue);
		}

		// this set now only contains keys which were not in the new object
		for (const key of oldKeys) {
			if (isOidKey(key)) continue;
			// push the delete for the property
			patches.push({
				oid,
				timestamp: getNow(),
				data: {
					op: 'remove',
					name: key,
				},
			});
		}
	}

	return patches;
}

/**
 * Takes a basic object and constructs a patch list to create it and
 * all of its nested objects.
 */
export function initialToPatches(
	initial: any,
	rootOid: ObjectIdentifier,
	getNow: () => string,
	createSubId?: () => string,
	patches: Operation[] = [],
) {
	assignOid(initial, rootOid);
	assignOidsToAllSubObjects(initial, createSubId);
	const normalized = normalize(initial);
	for (const key of normalized.keys()) {
		const value = normalized.get(key);
		patches.push({
			oid: key,
			timestamp: getNow(),
			data: {
				op: 'initialize',
				value: removeOid(value),
			},
		});
	}
	return patches;
}

export function shallowInitialToPatches(
	initial: any,
	rootOid: ObjectIdentifier,
	getNow: () => string,
	patches: Operation[] = [],
) {
	patches.push({
		oid: rootOid,
		timestamp: getNow(),
		data: {
			op: 'initialize',
			value: initial,
		},
	});
	return patches;
}

export function groupPatchesByIdentifier(patches: Operation[]) {
	const grouped: Record<ObjectIdentifier, Operation[]> = {};
	for (const patch of patches) {
		if (patch.oid in grouped) {
			grouped[patch.oid].push(patch);
		} else {
			grouped[patch.oid] = [patch];
		}
	}
	return grouped;
}

export function groupPatchesByRootOid(patches: Operation[]) {
	const grouped: Record<ObjectIdentifier, Operation[]> = {};
	for (const patch of patches) {
		const root = getOidRoot(patch.oid);
		if (root in grouped) {
			grouped[root].push(patch);
		} else {
			grouped[root] = [patch];
		}
	}
	return grouped;
}

export function groupBaselinesByRootOid(baselines: DocumentBaseline[]) {
	const grouped: Record<ObjectIdentifier, DocumentBaseline[]> = {};
	for (const patch of baselines) {
		const root = getOidRoot(patch.oid);
		if (root in grouped) {
			grouped[root].push(patch);
		} else {
			grouped[root] = [patch];
		}
	}
	return grouped;
}

export type NormalizedObject =
	| {
			[key: PropertyName]: PropertyValue;
	  }
	| Array<PropertyValue>;

function listCheck(obj: any): obj is Array<unknown> {
	if (!Array.isArray(obj)) {
		console.error(
			`Cannot apply list patch; expected array, received ${JSON.stringify(
				obj,
			)}. This suggests your data is changing from a list to an object over time. (OID: ${maybeGetOid(
				obj,
			)})`,
		);
		return false;
	} else {
		return true;
	}
}

/**
 * The incoming object should already be normalized!
 */
export function applyPatch<T extends NormalizedObject>(
	base: T | undefined,
	patch: OperationPatch,
): T | undefined {
	// deleted objects are represented by undefined
	// and remain deleted unless re-initialized
	if ((base === undefined || base === null) && patch.op !== 'initialize') {
		return base;
	}
	// ditch typing internally.
	const baseAsAny = base as any;
	let index;
	let spliceResult: any[];

	switch (patch.op) {
		case 'set':
			baseAsAny[patch.name] = patch.value;
			break;
		case 'remove':
			delete baseAsAny[patch.name];
			break;
		case 'list-push':
			if (listCheck(base)) {
				base.push(patch.value);
			}
			break;
		case 'list-delete':
			if (listCheck(base)) {
				base.splice(patch.index, patch.count);
			}
			break;
		case 'list-move-by-index':
			if (listCheck(base)) {
				spliceResult = base.splice(patch.from, 1);
				base.splice(patch.to, 0, spliceResult[0]);
			}
			break;
		case 'list-remove':
			if (listCheck(base)) {
				do {
					const valueToRemove = patch.value;
					if (patch.only === 'last') {
						if (isObjectRef(valueToRemove)) {
							index = findLastIndex(
								base,
								(item: any) => item.id === valueToRemove.id,
							);
						} else {
							index = base.lastIndexOf(valueToRemove);
						}
					} else {
						if (isObjectRef(valueToRemove)) {
							index = base.findIndex(
								(item: any) => item.id === valueToRemove.id,
							);
						} else {
							index = base.indexOf(valueToRemove);
						}
					}
					if (index !== -1) {
						base.splice(index, 1);
					}
				} while (!patch.only && index !== -1);
			}
			break;
		case 'list-add':
			if (listCheck(base)) {
				const alreadyHas = base.some((item: any) => {
					if (isObjectRef(item) && isObjectRef(patch.value)) {
						return item.id === patch.value.id;
					} else {
						return item === patch.value;
					}
				});
				if (!alreadyHas) {
					base.push(patch.value);
				}
			}
			break;
		case 'list-move-by-ref':
			if (listCheck(base)) {
				index = base.indexOf(patch.value);
				spliceResult = base.splice(index, 1);
				base.splice(patch.index, 0, spliceResult[0]);
			}
			break;
		case 'list-insert':
			if (listCheck(base)) {
				if (!patch.value && !patch.values) {
					throw new Error(
						`Cannot apply list insert patch; expected value or values, received ${JSON.stringify(
							patch,
						)}`,
					);
				}
				if (patch.value) {
					base.splice(patch.index, 0, patch.value);
				} else {
					base.splice(patch.index, 0, ...patch.values!);
				}
			}
			break;
		case 'delete':
			return undefined;
		case 'initialize':
			return cloneDeep(patch.value);
		default:
			throw new Error(`Unsupported patch operation: ${(patch as any).op}`);
	}
	return base;
}

export function applyOperations<T extends NormalizedObject>(
	base: T | undefined,
	operations: Operation[],
): T | undefined {
	let cur = base as T | undefined;
	for (const op of operations) {
		cur = applyPatch(base, op.data);
	}
	return cur;
}

/**
 * Mutates the original object in place. Returns all referenced
 * objects oids.
 */
export function substituteRefsWithObjects(
	base: any,
	refs: Map<ObjectIdentifier, any>,
	used: ObjectIdentifier[] = [],
): ObjectIdentifier[] {
	if (Array.isArray(base)) {
		for (let i = 0; i < base.length; i++) {
			const item = base[i];
			base[i] = dereference(item, refs, used);
			if (isObject(base[i])) {
				substituteRefsWithObjects(base[i], refs, used);
			}
		}
	} else if (isObject(base)) {
		// not sure where to put this assertion but it's important to make
		// sure all nested objects include an OID
		assert(
			maybeGetOid(base),
			`Object ${JSON.stringify(base)} must have an oid`,
		);
		for (const key of Object.keys(base)) {
			base[key] = dereference(base[key], refs, used);

			// now that objects are in place, recursively substitute
			if (isObject(base[key])) {
				substituteRefsWithObjects(base[key], refs, used);
			}
		}
	}

	return used;
}

function dereference(
	input: any,
	refs: Map<ObjectIdentifier, any>,
	used: ObjectIdentifier[],
): any {
	if (isObjectRef(input)) {
		used.push(input.id);
		const resolved = refs.get(input.id);
		assert(!!resolved, `No value was found in object map for ${input.id}`);
		return assignOid(resolved, input.id);
	} else {
		return input;
	}
}

export function substituteFirstLevelObjectsWithRefs<
	Base extends { [key: string]: any } | any[],
>(
	base: Base,
	refObjects: Map<ObjectIdentifier, any> = new Map(),
): Map<ObjectIdentifier, any> {
	if (Array.isArray(base)) {
		for (let i = 0; i < base.length; i++) {
			const item = base[i];
			if (isObject(item)) {
				const oid = getOid(item);
				base[i] = {
					'@@type': 'ref',
					id: oid,
				};
				refObjects.set(oid, item);
			}
		}
	} else {
		for (const [key, value] of Object.entries(base)) {
			if (isObject(value)) {
				base[key] = {
					'@@type': 'ref',
					id: getOid(value),
				};

				refObjects.set(getOid(value), value);
			}
		}
	}

	return refObjects;
}
