import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformer } from '@openfga/syntax-transformer';

/**
 * The authorization model, loaded from the checked-in DSL (model/model.fga).
 *
 * The DSL is the source of truth; the JSON OpenFGA stores is derived here. There is no
 * hand-maintained JSON copy to drift out of sync with what reviewers read.
 */

export const MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'model', 'model.fga');

export function loadModelDsl(path: string = MODEL_PATH): string {
  return readFileSync(path, 'utf8');
}

/** DSL → the JSON body accepted by POST /stores/{id}/authorization-models. */
export function modelToJson(dsl: string = loadModelDsl()): unknown {
  return transformer.transformDSLToJSONObject(dsl);
}
