set -eu
uv run --offline --frozen --project "$PI_CAD_PYTHON_PROJECT" python -m cadctl optimize --spec spec.json --output-dir outputs > result.json
