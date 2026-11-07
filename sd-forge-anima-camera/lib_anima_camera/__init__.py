# SPDX-FileCopyrightText: 2026 灰暗x
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Re-export of the Anima camera-control prompt engine for Forge Neo."""

from .camera import (
    DEFAULT_CONFIG,
    compute_camera_prompt,
    default_config,
    describe_state,
    distance_key,
    elevation_key,
    load_config,
)

__all__ = [
    "DEFAULT_CONFIG",
    "compute_camera_prompt",
    "default_config",
    "describe_state",
    "distance_key",
    "elevation_key",
    "load_config",
]
