"""Parameter expression handling (pure). protocol.md section 7 "Parameters".

Grammar: numbers, parameter names, + - * /, parentheses, units `mm` and `deg` (after a number).
A scalar's `expr` is accepted only when it (a) parses, (b) uses only known parameters,
(c) has the expected dimension (length -> mm^1, angle -> deg^1), and (d) evaluates to the scalar's
`value` (1e-6 relative). Otherwise the caller falls back to `value` and records a warning.
"""
import re

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Names Fusion's expression parser would read as functions/constants/units.
RESERVED = frozenset("""sin cos tan asin acos atan atan2 sinh cosh tanh sqrt abs exp ln log log10 sign
pi e floor ceil round min max pow mm cm m in ft deg rad ul""".split())
_TOKEN_RE = re.compile(r"\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(.))")
DIMS = {"length": (1, 0), "angle": (0, 1)}
UNIT_DIM = {"mm": (1, 0), "deg": (0, 1), "": (0, 0)}


class ExprError(Exception):
    pass


def valid_param_name(name):
    return isinstance(name, str) and bool(NAME_RE.match(name)) and name.lower() not in RESERVED


def _tokens(s):
    out, pos = [], 0
    s = s.strip()
    while pos < len(s):
        m = _TOKEN_RE.match(s, pos)
        if not m:
            break
        pos = m.end()
        if m.group(1) is not None:
            out.append(("num", m.group(1)))
        elif m.group(2) is not None:
            out.append(("name", m.group(2)))
        else:
            ch = m.group(3)
            if ch.isspace():
                continue
            if ch not in "+-*/()":
                raise ExprError("character %r is outside the expression grammar" % ch)
            out.append(("op", ch))
    return out


def _add_dim(a, b):
    return (a[0] + b[0], a[1] + b[1])


def _sub_dim(a, b):
    return (a[0] - b[0], a[1] - b[1])


class _S(str):
    """Expression text; `lit` marks a single unitless number literal (may adopt the other operand's unit)."""
    lit = False


_UNIT_TEXT = {(1, 0): " mm", (0, 1): " deg"}


class _Parser(object):
    def __init__(self, toks, params):
        self.t, self.i, self.params = toks, 0, params

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def expr(self):
        v, d, s = self.term()
        while self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            v2, d2, s2 = self.term()
            if d != d2:
                # A bare number next to a quantity takes that quantity's unit (Reify values are mm / deg).
                if d2 == (0, 0) and getattr(s2, "lit", False) and d in _UNIT_TEXT:
                    s2 = _S(s2 + _UNIT_TEXT[d])
                elif d == (0, 0) and getattr(s, "lit", False) and d2 in _UNIT_TEXT:
                    s, d = _S(s + _UNIT_TEXT[d2]), d2
                else:
                    raise ExprError("cannot %s quantities with different units" % ("add" if op == "+" else "subtract"))
            v = v + v2 if op == "+" else v - v2
            s = "%s %s %s" % (s, op, s2)
        return v, d, s

    def term(self):
        v, d, s = self.factor()
        while self.peek() in (("op", "*"), ("op", "/")):
            op = self.take()[1]
            v2, d2, s2 = self.factor()
            if op == "*":
                v, d = v * v2, _add_dim(d, d2)
            else:
                if v2 == 0:
                    raise ExprError("division by zero")
                v, d = v / v2, _sub_dim(d, d2)
            s = "%s %s %s" % (s, op, s2)
        return v, d, s

    def factor(self):
        if self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            v, d, s = self.factor()
            return (-v if op == "-" else v), d, op + s
        return self.atom()

    def atom(self):
        kind, val = self.take()
        if kind == "num":
            nxt = self.peek()
            if nxt[0] == "name":
                if nxt[1] not in ("mm", "deg"):
                    raise ExprError("unit %r is not supported (only mm, deg)" % nxt[1])
                self.take()
                return float(val), UNIT_DIM[nxt[1]], "%s %s" % (val, nxt[1])
            lit = _S(val)
            lit.lit = True
            return float(val), (0, 0), lit
        if kind == "name":
            if val not in self.params:
                raise ExprError("unknown parameter %r" % val)
            pv, pd = self.params[val]
            return pv, pd, val
        if (kind, val) == ("op", "("):
            v, d, s = self.expr()
            if self.take() != ("op", ")"):
                raise ExprError("missing )")
            return v, d, "(%s)" % s
        raise ExprError("unexpected %s" % (val if val else "end of expression"))


def analyze(expr, params):
    """params: name -> (value, dim). Returns (value, dim, fusion_expression). Raises ExprError."""
    if not isinstance(expr, str):
        raise ExprError("expression is not text")
    text = expr.strip()
    if text.startswith("="):
        text = text[1:]
    toks = _tokens(text)
    if not toks:
        raise ExprError("empty expression")
    p = _Parser(toks, params)
    v, d, s = p.expr()
    if p.i != len(toks):
        raise ExprError("unexpected %r" % (toks[p.i][1],))
    return v, d, s


class Binder(object):
    """Holds user parameters and turns scalars into (value, expr, fusion_expr or None)."""

    def __init__(self, parameters=None, bind=True, warnings=None):
        self.warnings = warnings if warnings is not None else []
        self.bind = bind
        self.plan = []      # parameters to create in Fusion, in order
        self.names = {}     # name -> (value, dim)
        for p in (parameters or []):
            self._add(p)

    def warn(self, feature, field, expr, reason):
        self.warnings.append({"feature": feature, "field": field, "expr": expr, "reason": reason})

    def _add(self, p):
        name = p.get("name")
        unit = p.get("unit", "") or ""
        if not self.bind:
            return
        if unit not in UNIT_DIM or not valid_param_name(name) or name in self.names:
            self.warn(None, "parameter:%s" % name, p.get("expr"),
                      "parameter not created (name or unit not usable as a Fusion user parameter)")
            return
        value = float(p["value"])
        fx = None
        if p.get("expr"):
            try:
                v, d, s = analyze(p["expr"], self.names)
                if d != UNIT_DIM[unit] or abs(v - value) > 1e-6 * max(1.0, abs(value)):
                    raise ExprError("expression does not match unit/value")
                fx = s
            except ExprError as e:
                self.warn(None, "parameter:%s" % name, p.get("expr"), str(e))
        self.names[name] = (value, UNIT_DIM[unit])
        self.plan.append({"name": name, "unit": unit, "value": value, "fx": fx})

    def scalar(self, x, kind, feature, field):
        """x: {'value','expr'} or number. kind 'length' or 'angle' (or None for a count). -> (value, expr, fx)."""
        if isinstance(x, dict) and "value" in x:
            value, expr = float(x["value"]), x.get("expr")
        elif isinstance(x, (int, float)) and not isinstance(x, bool):
            return float(x), None, None
        else:
            return None, None, None
        if not expr or not self.bind:
            return value, expr, None
        try:
            v, d, s = analyze(expr, self.names)
            if kind and d != DIMS[kind]:
                raise ExprError("expression has unit dimension %s, expected %s" % (d, DIMS[kind]))
            if abs(v - value) > 1e-6 * max(1.0, abs(value)):
                raise ExprError("expression evaluates to %r but value is %r" % (v, value))
            return value, expr, s
        except ExprError as e:
            self.warn(feature, field, expr, str(e))
            return value, expr, None
