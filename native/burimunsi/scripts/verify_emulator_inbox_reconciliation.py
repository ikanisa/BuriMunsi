#!/usr/bin/env python3
"""Inject one synthetic carrier SMS in an Android emulator and exercise its stored row in the receiver adapter."""
import argparse
from datetime import datetime
from zoneinfo import ZoneInfo
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time

SENDER = "15555219877"
BODY = "You have received 1000 RWF from EXAMPLE (*****001) at 2026-11-22 15:00:00. Balance: 2000 RWF. FT Id: 987654321."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--wire-output", type=Path)
    parser.add_argument("--payer", choices=("masked","full"), default="masked")
    options = parser.parse_args()
    serial = options.serial
    local_at = datetime.now(ZoneInfo("Africa/Kigali")).strftime("%Y-%m-%d %H:%M:%S")
    body = BODY if options.payer == "masked" else (
        f"You have received 1000 RWF from EXAMPLE (+250780000001) at {local_at}. Balance: 2000 RWF. FT Id: 987654322."
    )
    if not re.fullmatch(r"emulator-[0-9]+", serial):
        raise SystemExit("Specify an Android Emulator serial.")

    def adb(*args):
        return subprocess.check_output(["adb", "-s", serial, *args], text=True, timeout=20).strip()

    if adb("shell", "getprop", "ro.boot.qemu") != "1":
        raise SystemExit("The selected target must be an emulator.")

    def rows():
        # Leave unrelated inbox records on the emulator.
        output = adb("shell", "content query --uri content://sms/inbox --projection _id:date:date_sent:sub_id:address:body "
                     f'--where "address IN (\'{SENDER}\',\'+{SENDER}\')"')
        result = []
        for line in output.splitlines():
            match = re.fullmatch(r"Row: \d+ _id=(\d+), date=(\d+), date_sent=(\d+), sub_id=(-?\d+), address=(\+?\d+), body=(.*)", line)
            if match and match[5].lstrip("+") == SENDER and match[6] == body:
                result.append(dict(_id=int(match[1]), date=int(match[2]), date_sent=int(match[3]),
                                   sub_id=int(match[4]), address=match[5], body=body))
        return result

    existing = {row["_id"] for row in rows()}
    started = time.monotonic_ns()
    if "OK" not in adb("emu", "sms", "send", SENDER, body):
        raise RuntimeError("The emulator did not accept the synthetic SMS.")
    accepted = time.monotonic_ns()
    deadline = time.monotonic()+45
    while time.monotonic() < deadline:
        current = [row for row in rows() if row["_id"] not in existing]
        if len(current) == 1 and current[0]["sub_id"] >= 0:
            break
        time.sleep(.05)
    else:
        raise RuntimeError("The emulator inbox did not supply one new SMS with a known subscription.")
    current[0]["emulatorCommandAckMs"] = round((accepted-started)/1e6, 2)
    current[0]["emulatorInjectionToObservedInboxMs"] = round((time.monotonic_ns()-started)/1e6, 2)
    with tempfile.TemporaryDirectory(prefix="buri-emulated-inbox-") as tmp:
        fixture = Path(tmp, "receipt.json")
        fixture.write_text(json.dumps(current[0]))
        script = Path(__file__).with_name("verify_observation_adapter.sh")
        command = ["bash", str(script), "--emulator-sms", str(fixture)]
        if options.wire_output:
            command.append(str(options.wire_output.resolve()))
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
