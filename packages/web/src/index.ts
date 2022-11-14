export { StorageDescriptor, Storage } from './Storage.js';
export type { StorageInitOptions } from './Storage.js';
export { Query } from './Query.js';
export { ObjectEntity, ListEntity } from './reactives/Entity.js';
export type { Entity, EntityShape } from './reactives/Entity.js';
export { ServerSync as WebsocketSync } from './Sync.js';

export {
	collection,
	schema,
	createDefaultMigration,
	migrate,
} from '@lo-fi/common';
export type {
	StorageDocument,
	StorageSchema,
	StorageCollectionSchema,
	Migration,
} from '@lo-fi/common';

export interface Presence {}

export interface Profile {}

import type { UserInfo as BaseUserInfo } from '@lo-fi/common';

export type UserInfo = BaseUserInfo<Profile, Presence>;
