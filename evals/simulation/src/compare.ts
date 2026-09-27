/**
 * How closely a simulated effect predicted the executed one — docs/module2.md §11.2.
 *
 * The comparison itself lives in @vega/compensators (docs/module6.md §5.7): the executor runs
 * the SAME facets after every call to detect divergence, so this harness and production can
 * never disagree about what "matched" means.
 */
export { compareEffects, type Comparison, type Facet } from '@vega/compensators';
