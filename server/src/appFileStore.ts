import { NodeFsAppFileStore } from "./dao/file-store/NodeFsAppFileStore.js";
import type { IAppFileStore } from "./dao/file-store/IAppFileStore.js";

/** Default file store; replace with e.g. `new S3AppFileStore(...)` to use object storage. */
export const appFileStore: IAppFileStore = new NodeFsAppFileStore();

export type { IAppFileStore } from "./dao/file-store/IAppFileStore.js";
