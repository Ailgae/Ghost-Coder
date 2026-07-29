#!/bin/bash
# Track file changes and report lines added/removed

if [ $# -ne 2 ]; then
    echo "Usage: $0 <base_ref> <new_ref>"
    exit 1
fi

BASE_REF="$1"
NEW_REF="$2"

echo "Tracking changes between $BASE_REF and $NEW_REF..."
echo ""

# Get list of changed files
git diff --name-only "$BASE_REF" "$NEW_REF" | while read -r file; do
    # Calculate lines added and removed for each file
    ADDED=$(git diff "$BASE_REF" "$NEW_REF" -- "$file" | grep -E "^\+" | wc -l)
    REMOVED=$(git diff "$BASE_REF" "$NEW_REF" -- "$file" | grep -E "^-" | wc -l)
    
    # Skip binary files
    if [ $ADDED -eq 0 ] && [ $REMOVED -eq 0 ]; then
        continue
    fi
    
    echo "File: $file"
    echo "  Lines added: $ADDED"
    echo "  Lines removed: $REMOVED"
    echo ""
done
