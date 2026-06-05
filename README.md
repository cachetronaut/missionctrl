# MissionCtrl

Local-first MissionCtrl that composes capability tokens, budgets, graph events, and Plugg authentication into one per-action pipeline.

This repository contains the TypeScript and Python implementations for the MissionCtrl primitive. The shared repository keeps the public contract, fixtures, and release history aligned across both languages.

## Packages

- npm: `missionctrl`
- PyPI: `missionctrl`

## Install

```sh
npm install missionctrl
pip install missionctrl
```

## Layout

- `ts/` - TypeScript implementation and npm package.
- `py/` - Python implementation and PyPI package.
- `fixtures/` - Shared conformance and parity fixtures when the primitive needs them.

## Development

Run TypeScript checks from `ts/`:

```sh
pnpm verify
```

Run Python checks from `py/`:

```sh
uv sync --dev
uv run --with ruff ruff check .
uv run --with ruff ruff format --check .
uv run --with ty ty check
uv run --with pytest --with pytest-asyncio python -m pytest
```

## License

MIT
