"""Verification layer (brief §9): ERA5 reference fetch, observation matching,
calibration accumulation, and the retrospective corpus.

Honesty rules (binding, from §9):
- coverage classes on every result; synthetic observations can never claim
  real verification (they are always 'emulated');
- calibration records always carry sample size; no weighting logic;
- ERA5 comparisons are 'reanalysis-referenced' — assimilates observations,
  but is not independent ground truth.
"""

from .calibration import LEAD_BANDS, accumulate_calibration
from .corpus import evaluate_expectations, load_cases, run_case, run_corpus
from .era5 import fetch_era5_case, open_case_dataset
from .match import match_snapshot, write_verification

__all__ = [
    "LEAD_BANDS",
    "accumulate_calibration",
    "evaluate_expectations",
    "fetch_era5_case",
    "load_cases",
    "match_snapshot",
    "open_case_dataset",
    "run_case",
    "run_corpus",
    "write_verification",
]
