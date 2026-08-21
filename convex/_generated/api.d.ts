/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as androidReadToken from "../androidReadToken.js";
import type * as btcLedger from "../btcLedger.js";
import type * as crons from "../crons.js";
import type * as dataFiles from "../dataFiles.js";
import type * as dateValidation from "../dateValidation.js";
import type * as deviceAuth from "../deviceAuth.js";
import type * as documentProjection from "../documentProjection.js";
import type * as marketQuoteAcquire from "../marketQuoteAcquire.js";
import type * as marketQuotes from "../marketQuotes.js";
import type * as migrate from "../migrate.js";
import type * as operatorImport from "../operatorImport.js";
import type * as operatorImportValidation from "../operatorImportValidation.js";
import type * as readCanary from "../readCanary.js";
import type * as tables from "../tables.js";
import type * as todoNormalize from "../todoNormalize.js";
import type * as writeback from "../writeback.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  androidReadToken: typeof androidReadToken;
  btcLedger: typeof btcLedger;
  crons: typeof crons;
  dataFiles: typeof dataFiles;
  dateValidation: typeof dateValidation;
  deviceAuth: typeof deviceAuth;
  documentProjection: typeof documentProjection;
  marketQuoteAcquire: typeof marketQuoteAcquire;
  marketQuotes: typeof marketQuotes;
  migrate: typeof migrate;
  operatorImport: typeof operatorImport;
  operatorImportValidation: typeof operatorImportValidation;
  readCanary: typeof readCanary;
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
