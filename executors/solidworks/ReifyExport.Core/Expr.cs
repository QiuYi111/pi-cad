using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Reify.Export
{
    public sealed class ExprException : Exception
    {
        public ExprException(string m) : base(m) { }
    }

    /// <summary>
    /// Expression grammar of protocol section 7: numbers, parameter names, + - * /, parentheses, units mm and deg
    /// (a unit follows a number: "5mm", "90 deg"). A leading "=" and a leading "Params." are accepted and dropped.
    /// Anything else throws ExprException (the caller falls back to the plain value and adds a warning).
    /// </summary>
    public abstract class ExprNode
    {
        public abstract double Eval(IReadOnlyDictionary<string, double> names);
        /// <summary>SolidWorks equation right-hand side: parameter names become "name" (global variable), numbers keep their unit suffix.</summary>
        public abstract string ToSw();
        public abstract void CollectNames(ICollection<string> into);
    }

    sealed class NumNode : ExprNode
    {
        public double V; public string Unit = "";
        public override double Eval(IReadOnlyDictionary<string, double> n) => V;
        public override string ToSw() => V.ToString("R", CultureInfo.InvariantCulture) + Unit;
        public override void CollectNames(ICollection<string> into) { }
    }

    sealed class NameNode : ExprNode
    {
        public string Name = "";
        public override double Eval(IReadOnlyDictionary<string, double> n)
        {
            if (!n.TryGetValue(Name, out var v)) throw new ExprException("unknown parameter '" + Name + "'");
            return v;
        }
        public override string ToSw() => "\"" + Name + "\"";
        public override void CollectNames(ICollection<string> into) { into.Add(Name); }
    }

    sealed class NegNode : ExprNode
    {
        public ExprNode A = null!;
        public override double Eval(IReadOnlyDictionary<string, double> n) => -A.Eval(n);
        public override string ToSw() => "-" + A.ToSw();
        public override void CollectNames(ICollection<string> into) { A.CollectNames(into); }
    }

    sealed class BinNode : ExprNode
    {
        public char Op; public ExprNode L = null!, R = null!;
        public override double Eval(IReadOnlyDictionary<string, double> n)
        {
            double a = L.Eval(n), b = R.Eval(n);
            switch (Op)
            {
                case '+': return a + b;
                case '-': return a - b;
                case '*': return a * b;
                default:
                    if (b == 0) throw new ExprException("division by zero");
                    return a / b;
            }
        }
        public override string ToSw() => "(" + L.ToSw() + " " + Op + " " + R.ToSw() + ")";
        public override void CollectNames(ICollection<string> into) { L.CollectNames(into); R.CollectNames(into); }
    }

    public static class ExprParser
    {
        public static ExprNode Parse(string text)
        {
            if (text == null) throw new ExprException("empty expression");
            string s = text.Trim();
            if (s.StartsWith("=")) s = s.Substring(1).Trim();
            if (s.StartsWith("Params.", StringComparison.Ordinal)) s = s.Substring(7);
            if (s.Length == 0) throw new ExprException("empty expression");
            int pos = 0;
            var node = ParseSum(s, ref pos);
            SkipWs(s, ref pos);
            if (pos != s.Length) throw new ExprException("unexpected '" + s[pos] + "' at position " + pos);
            return node;
        }

        static void SkipWs(string s, ref int p) { while (p < s.Length && char.IsWhiteSpace(s[p])) p++; }

        static ExprNode ParseSum(string s, ref int p)
        {
            var l = ParseProduct(s, ref p);
            while (true)
            {
                SkipWs(s, ref p);
                if (p < s.Length && (s[p] == '+' || s[p] == '-'))
                {
                    char op = s[p++];
                    var r = ParseProduct(s, ref p);
                    l = new BinNode { Op = op, L = l, R = r };
                }
                else return l;
            }
        }

        static ExprNode ParseProduct(string s, ref int p)
        {
            var l = ParseUnary(s, ref p);
            while (true)
            {
                SkipWs(s, ref p);
                if (p < s.Length && (s[p] == '*' || s[p] == '/'))
                {
                    char op = s[p++];
                    var r = ParseUnary(s, ref p);
                    l = new BinNode { Op = op, L = l, R = r };
                }
                else return l;
            }
        }

        static ExprNode ParseUnary(string s, ref int p)
        {
            SkipWs(s, ref p);
            if (p < s.Length && s[p] == '-') { p++; return new NegNode { A = ParseUnary(s, ref p) }; }
            if (p < s.Length && s[p] == '+') { p++; return ParseUnary(s, ref p); }
            return ParsePrimary(s, ref p);
        }

        static ExprNode ParsePrimary(string s, ref int p)
        {
            SkipWs(s, ref p);
            if (p >= s.Length) throw new ExprException("unexpected end of expression");
            char c = s[p];
            if (c == '(')
            {
                p++;
                var e = ParseSum(s, ref p);
                SkipWs(s, ref p);
                if (p >= s.Length || s[p] != ')') throw new ExprException("missing ')'");
                p++;
                return e;
            }
            if (char.IsDigit(c) || c == '.')
            {
                int st = p;
                while (p < s.Length && (char.IsDigit(s[p]) || s[p] == '.')) p++;
                if (p < s.Length && (s[p] == 'e' || s[p] == 'E') && p + 1 < s.Length && (char.IsDigit(s[p + 1]) || ((s[p + 1] == '-' || s[p + 1] == '+') && p + 2 < s.Length && char.IsDigit(s[p + 2]))))
                {
                    p += 2;
                    while (p < s.Length && char.IsDigit(s[p])) p++;
                }
                if (!double.TryParse(s.Substring(st, p - st), NumberStyles.Float, CultureInfo.InvariantCulture, out double v))
                    throw new ExprException("bad number '" + s.Substring(st, p - st) + "'");
                var n = new NumNode { V = v };
                int save = p;
                SkipWs(s, ref p);
                int us = p;
                while (p < s.Length && char.IsLetter(s[p])) p++;
                string unit = s.Substring(us, p - us);
                if (unit == "mm" || unit == "deg") n.Unit = unit;
                else if (unit.Length == 0) p = save;
                else throw new ExprException("unit '" + unit + "' is not supported (only mm and deg)");
                return n;
            }
            if (char.IsLetter(c) || c == '_')
            {
                int st = p;
                while (p < s.Length && (char.IsLetterOrDigit(s[p]) || s[p] == '_')) p++;
                string id = s.Substring(st, p - st);
                if (p < s.Length && s[p] == '(') throw new ExprException("function calls are not supported ('" + id + "')");
                if (p < s.Length && s[p] == '.') throw new ExprException("member access is not supported");
                return new NameNode { Name = id };
            }
            throw new ExprException("unexpected '" + c + "' at position " + p);
        }
    }
}
