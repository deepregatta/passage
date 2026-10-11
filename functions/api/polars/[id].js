// GET /api/polars/<id>: one verified boat polar from the pinned release.
import { handleBoat } from '../../../server/polars.mjs';

export const onRequestGet = handleBoat;
