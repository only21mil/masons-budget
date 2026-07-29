/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as dataFiles from "../dataFiles.js";
import type * as dateValidation from "../dateValidation.js";
import type * as documentProjection from "../documentProjection.js";
import type * as migrate from "../migrate.js";
import type * as tables from "../tables.js";
import type * as todoNormalize from "../todoNormalize.js";
import type * as writeback from "../writeback.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  dataFiles: typeof dataFiles;
  dateValidation: typeof dateValidation;
  documentProjection: typeof documentProjection;
  migrate: typeof migrate;
  tables: typeof tables;
  todoNormalize: typeof todoNormalize;
  writeback: typeof writeback;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
