// GET /api/polars: the pinned release's boat list for the picker (no polar data).
import { handleIndex } from '../../../server/polars.mjs';

export const onRequestGet = handleIndex;
