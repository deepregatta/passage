"""The credit footer of the synoptic chart PNGs.

The recorded ECMWF terms (forecast-tiles DATA-LICENSES.md, "Terms read on 12 November
2026") ask for the service sentence, the source, the licence link and a statement that
the data were modified, shown with the product. The footer is the only credit on the
image, so it carries them, on two lines, inside the picture.
"""

from __future__ import annotations

import numpy as np
import pytest
import xarray as xr
from matplotlib.figure import Figure

from deepweather_analysis.synoptic import render as render_module
from deepweather_analysis.synoptic.render import render_panels

SENTENCE = (
    "This service is based on data and products of the European Centre for "
    "Medium-Range Weather Forecasts (ECMWF)"
)


def _dataset() -> xr.Dataset:
    lats = np.arange(35.0, 65.01, 1.0)
    lons = np.arange(-35.0, 10.01, 1.0)
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    # Pascals: the renderer detects the unit
    msl = 101300.0 + 40.0 * np.sin(np.radians(lat_grid * 3)) + 30.0 * np.cos(np.radians(lon_grid * 4))
    return xr.Dataset(
        {"msl": (("step", "latitude", "longitude"), msl[None])},
        coords={"step": [0], "latitude": lats, "longitude": lons},
    )


@pytest.fixture()
def footer(tmp_path, monkeypatch):
    """The figure-level texts of one rendered panel, with their pixel extents."""
    texts = []
    original = Figure.text

    def record(self, *args, **kwargs):
        text = original(self, *args, **kwargs)
        texts.append((self, text))
        return text

    extents = []
    real_savefig = Figure.savefig

    def savefig(self, *args, **kwargs):
        # measure on the figure that is written, before it is closed
        renderer = self.canvas.get_renderer()
        for fig, text in texts:
            if fig is self:
                extents.append((text.get_text(), text.get_window_extent(renderer), self.bbox))
        return real_savefig(self, *args, **kwargs)

    monkeypatch.setattr(Figure, "text", record)
    monkeypatch.setattr(Figure, "savefig", savefig)
    render_panels(_dataset(), [], tmp_path, steps=(0,))
    assert render_module  # the module under test was imported
    return extents


def test_footer_carries_the_service_sentence_the_licence_link_and_a_modification_statement(footer):
    lines = [text for text, _extent, _figure in footer]
    joined = " ".join(lines)
    assert SENTENCE in joined
    assert "ECMWF open data" in joined
    assert "CC BY 4.0" in joined
    assert "https://creativecommons.org/licenses/by/4.0/" in joined
    assert "modified" in joined
    assert "isobars every 4 hPa" in joined
    assert "deepweather" not in joined.lower()


def test_footer_is_two_lines_inside_the_image_and_legible(footer):
    assert len(footer) == 2
    for _text, extent, figure in footer:
        assert extent.x0 >= 0 and extent.y0 >= 0
        assert extent.x1 <= figure.width and extent.y1 <= figure.height
    # the two lines do not overlap
    (_a, first, _fa), (_b, second, _fb) = sorted(footer, key=lambda item: -item[1].y0)
    assert first.y0 >= second.y1 - 0.5
