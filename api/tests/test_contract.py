"""The API and design/v3/spec/openapi.yaml describe the same routes, and the spec is valid."""
import re
from pathlib import Path

import yaml
from openapi_spec_validator import validate

SPEC = Path(__file__).resolve().parents[2] / "design" / "v3" / "spec" / "openapi.yaml"


def norm(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "{}", path)


def test_spec_is_valid():
    validate(yaml.safe_load(SPEC.read_text()))


def test_every_route_is_documented_and_every_documented_route_exists(client):
    spec = yaml.safe_load(SPEC.read_text())
    documented = {(norm(p), m.upper()) for p, ops in spec["paths"].items() for m in ops if m in ("get", "post", "put", "patch", "delete")}
    generated = client.app.openapi()["paths"]  # what FastAPI actually routes
    served = {(norm(p[len("/api/v1"):]), m.upper()) for p, ops in generated.items() if p.startswith("/api/v1/") for m in ops}
    assert served - documented == set(), "routes missing from openapi.yaml"
    assert documented - served == set(), "documented routes the API doesn't serve"
