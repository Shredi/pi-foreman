#!/bin/bash
# Hidden tests: copied to /tests by Harbor after the agent finished; reward 1 only if all pass.
mkdir -p /logs/verifier
cd /app
if python3 -m unittest discover -s /tests -p 'test_*.py' -v; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
