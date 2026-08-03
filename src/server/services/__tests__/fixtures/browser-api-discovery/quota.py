import json
import subprocess
import sys

# The current task supplies a sanitized BrokerRequest on stdin. This fixture
# deliberately persists neither the recipe nor its opaque auth binding.
request = json.load(sys.stdin)
completed = subprocess.run(
    ["comate", "api", "request", "--stdin", "--json"],
    input=json.dumps(request),
    text=True,
    check=True,
    capture_output=True,
)
print(completed.stdout, end="")
