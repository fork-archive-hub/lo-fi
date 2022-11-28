import { collection, createDefaultMigration, schema } from '@lo-fi/common';
// @ts-ignore
import { IDBFactory } from 'fake-indexeddb';
import { StorageDescriptor } from '../../index.js';

export const todoCollection = collection({
	name: 'todo',
	primaryKey: 'id',
	fields: {
		id: {
			type: 'string',
			indexed: true,
			default: () => Math.random().toString(36).slice(2, 9),
		},
		content: {
			type: 'string',
			indexed: true,
		},
		done: {
			type: 'boolean',
			default: false,
		},
		tags: {
			type: 'array',
			items: {
				type: 'string',
			},
		},
		category: {
			type: 'string',
		},
		attachments: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
					},
					test: {
						type: 'number',
						default: 1,
					},
				},
			},
		},
	},
	synthetics: {
		example: {
			type: 'string',
			compute: (doc) => doc.content,
		},
	},
	compounds: {
		tagsSortedByDone: {
			of: ['tags', 'done'],
		},
		categorySortedByDone: {
			of: ['category', 'done'],
		},
	},
});

export const weirdCollection = collection({
	name: 'weird',
	primaryKey: 'id',
	fields: {
		id: {
			type: 'string',
			indexed: true,
			default: () => Math.random().toString(36).slice(2, 9),
		},
		weird: {
			type: 'any',
		},
		map: {
			type: 'map',
			values: {
				type: 'string',
			},
		},
		objectMap: {
			type: 'map',
			values: {
				type: 'object',
				properties: {
					content: {
						type: 'string',
					},
				},
			},
		},
		reference: {
			type: 'ref',
			collection: 'todos',
		},
	},
	synthetics: {},
	compounds: {},
});

const testSchema = schema({
	version: 1,
	collections: {
		todo: todoCollection,
		weird: weirdCollection,
	},
});

export function createTestStorage() {
	const idb = new IDBFactory();
	const storage = new StorageDescriptor({
		schema: testSchema,
		migrations: [createDefaultMigration(testSchema)],
		indexedDb: idb,
		namespace: 'test',
	}).open();
	return storage;
}
