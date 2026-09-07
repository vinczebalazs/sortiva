/**
 * The drawer's recommendation shape, kept at the address the opportunities
 * barrel already names.
 *
 * The mapping itself moved to `optimize/recommendation-view.ts`, next to the
 * recommendation type it reads and inside the lane that changes that type — so
 * the next change to the shape of a recommendation does not have to be made in
 * two places, which is how the drawer and the recommendation card came to hold
 * two copies of one mapping in the first place. Nothing here adds behaviour;
 * these are the same values under the same names.
 */
export {
  GENERATING,
  NO_RECOMMENDATION,
  OPTIMIZE_FAILED_VALIDATION_KEY,
  toDrawerRecommendation,
  type DrawerRecommendation,
  type DrawerRecommendationField,
  type StoredRecommendation,
} from '../optimize/recommendation-view'
