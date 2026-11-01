"""Static checks for the PulseBank KYC changes (pure Python, no node needed).

1. Bracket/string balance for kyc.js and migrate.js.
2. Identifier check for the manual-review fallback: every use of
   MANUAL_REVIEW / MANUAL_REVIEW_ENABLED in kyc.js must have a matching
   declaration in the same file. (The 2025-11-01 prod 502 churn was exactly
   this: names used at runtime but never declared - syntax-valid, crash on
   first POST.)
3. migrate.js must keep the session_id DROP NOT NULL alteration.

Exit 0 = OK, 1 = broken.
"""
import re, sys

DECL_RE = re.compile(r'\b(?:const|let|var)\s+(MANUAL_REVIEW(?:_ENABLED)?)\b')

def balanced(src, name):
    stack, pairs, mode, i, n = [], {')': '(', ']': '[', '}': '{'}, None, 0, len(src)
    while i < n:
        c = src[i]
        if mode == 'line':
            if c == '\n': mode = None
            i += 1; continue
        if mode == 'block':
            if src[i:i+2] == '*/': mode = None; i += 2; continue
            i += 1; continue
        if mode in ("'", '"', '`'):
            if c == '\\': i += 2; continue
            if c == mode: mode = None
            i += 1; continue
        if src[i:i+2] == '//': mode = 'line'; i += 2; continue
        if src[i:i+2] == '/*': mode = 'block'; i += 2; continue
        if c in '\'"`': mode = c; i += 1; continue
        if c in '([{': stack.append(c); i += 1; continue
        if c in ')]}':
            if not stack or stack[-1] != pairs[c]:
                print(f'{name}: delimiter mismatch at offset {i} (got {c})')
                return False
            stack.pop(); i += 1; continue
        i += 1
    if stack or mode:
        print(f'{name}: unbalanced at EOF (stack={stack}, mode={mode})')
        return False
    return True

def declared_names(src):
    return set(DECL_RE.findall(src))

def used_names(src):
    used = set()
    for name in ('MANUAL_REVIEW_ENABLED', 'MANUAL_REVIEW'):
        if re.search(r'\b' + name + r'\b', src):
            used.add(name)
    return used

def main():
    kyc = open('api/src/routes/kyc.js').read()
    mig = open('api/src/ledger/migrate.js').read()
    ok = balanced(kyc, 'kyc.js') and balanced(mig, 'migrate.js')

    declared, used = declared_names(kyc), used_names(kyc)
    missing = used - declared
    if missing:
        print(f'kyc.js: used but never declared: {sorted(missing)}  '
              f'(crashes at runtime with ReferenceError)')
        ok = False
    elif used:
        print(f'kyc.js: manual-review flags declared: {sorted(declared & used)}')

    if 'res.status(202)' not in kyc:
        print('kyc.js: 202 manual_review fallback missing')
        ok = False

    # The POST /session catch block must not rely on try-block locals
    # (reference/email/account_type) - they are out of scope there and crash
    # with ReferenceError on the first request. It must re-read req.body.
    catchm = re.search(r'router\.post\(\'/session\'.*?\} catch \(e\) \{(.*?)\n  \}\);', kyc, re.S)
    if catchm and 'IDENTITY_NOT_ENABLED' in catchm.group(1):
        if 'const body = req.body' not in catchm.group(1):
            print('kyc.js: /session catch block uses try-scoped locals without re-reading req.body')
            ok = False

    if 'DROP NOT NULL' not in mig:
        print('migrate.js: session_id DROP NOT NULL alteration missing')
        ok = False

    print('KYC STATIC CHECKS OK' if ok else 'KYC STATIC CHECKS FAILED')
    sys.exit(0 if ok else 1)

main()
