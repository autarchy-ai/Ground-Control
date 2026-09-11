#!/bin/bash
# Block edits to sensitive files (.env, credentials, keys)
FILE_PATH=$(jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" ]]; then
    exit 0
fi

BASENAME=$(basename "$FILE_PATH")

# The committed root placeholder template is secret-free by convention and is
# the only way to advertise a config key at all, so it must be editable.
#
# The exemption is by exact repository-relative path, never by basename: a
# basename rule would exempt any nested `.env.example`, and an attacker-supplied
# `.env.example` symlink pointing at a real `.env` would be followed by the write
# while this hook only ever saw the harmless alias. Symlinks are refused outright
# for the same reason — the guard must judge the file that actually gets written.
ENV_TEMPLATE_ALLOWLIST=(
    ".env.example"
)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
ABS_PATH=$(realpath -m -- "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
ABS_PROJECT=$(realpath -m -- "$PROJECT_DIR" 2>/dev/null || echo "$PROJECT_DIR")
REL_PATH="${ABS_PATH#"$ABS_PROJECT"/}"

is_exempt_template() {
    # A symlink is never exempt: the write follows it, this hook would not.
    if [[ -L "$FILE_PATH" ]]; then
        return 1
    fi
    # Nor is a hard link. An allowlisted name pointing at a second link to a
    # protected .env shares the inode, so the write lands on the secret while
    # this hook only ever sees the harmless path. A real template has one link.
    if [[ -e "$FILE_PATH" ]]; then
        local links
        links=$(stat -c '%h' -- "$FILE_PATH" 2>/dev/null || echo 1)
        if [[ "$links" != "1" ]]; then
            return 1
        fi
    fi
    local candidate
    for candidate in "${ENV_TEMPLATE_ALLOWLIST[@]}"; do
        if [[ "$REL_PATH" == "$candidate" ]]; then
            return 0
        fi
    done
    return 1
}

# Block .env files carrying real secrets.
case "$BASENAME" in
    .env*|local_settings.py)
        if [[ "$BASENAME" == .env* ]] && is_exempt_template; then
            :
        else
            echo "BLOCKED: Editing $BASENAME is not allowed. These files contain secrets." >&2
            exit 2
        fi
        ;;
esac

# Block key/credential files
if [[ "$BASENAME" == *.key ]] || [[ "$BASENAME" == *.pem ]] || [[ "$BASENAME" == "credentials"* ]]; then
    echo "BLOCKED: Editing $BASENAME is not allowed. These files contain secrets." >&2
    exit 2
fi

exit 0
