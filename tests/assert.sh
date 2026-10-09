#!/usr/bin/env bash
# Minimal assertion helpers shared by AundeKiosk bash tests.
# Usage: source this file, call assert_eq/assert_status repeatedly,
# then call assert_summary at the end.

ASSERT_PASS=0
ASSERT_FAIL=0

assert_eq() {
  local expected="$1"
  local actual="$2"
  local description="$3"
  if [[ "$expected" == "$actual" ]]; then
    ASSERT_PASS=$((ASSERT_PASS + 1))
    echo "ok - $description"
  else
    ASSERT_FAIL=$((ASSERT_FAIL + 1))
    echo "NOT OK - $description (expected '$expected', got '$actual')"
  fi
}

assert_status() {
  local expected_status="$1"
  local actual_status="$2"
  local description="$3"
  if [[ "$expected_status" -eq "$actual_status" ]]; then
    ASSERT_PASS=$((ASSERT_PASS + 1))
    echo "ok - $description"
  else
    ASSERT_FAIL=$((ASSERT_FAIL + 1))
    echo "NOT OK - $description (expected status '$expected_status', got '$actual_status')"
  fi
}

assert_summary() {
  echo ""
  echo "$ASSERT_PASS passed, $ASSERT_FAIL failed"
  [[ "$ASSERT_FAIL" -eq 0 ]]
}
