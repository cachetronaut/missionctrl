# missionctrl

Python implementation of MissionCtrl.

For product-level context, shared contracts, and cross-language repository information, see the public repository: https://github.com/cachetronaut/missionctrl.

## Install

```sh
pip install missionctrl
```

## Import

```python
import missionctrl
```

## Development

Run from `py/`:

```sh
uv sync --dev
uv run --with ruff ruff check .
uv run --with ruff ruff format --check .
uv run --with ty ty check
uv run --with pytest --with pytest-asyncio python -m pytest
```

## License

MIT
