#!/usr/bin/env python3
"""Run upstream's isolated release CPU cases and retain their raw evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', required=True, type=Path)
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--seconds', type=int, default=30)
    args = parser.parse_args()
    build = json.loads(args.build.read_text())
    candidate = Path(build['binary'])
    assert hashlib.sha256(candidate.read_bytes()).hexdigest() == build['binary_sha256']
    baseline = args.baseline.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    case = Path(build['source']) / 'scripts/release_perf_case.sh'
    report = {'candidate_sha256': build['binary_sha256'], 'base': build['base'], 'patch_sha256': build['patch_sha256'],
              'baseline_sha256': hashlib.sha256(baseline.read_bytes()).hexdigest(),
              'baseline_version': subprocess.check_output([str(baseline), '--version'], text=True).strip(),
              'seconds': args.seconds, 'cases': [], 'scope': 'Native Herdr CPU; no Swift subscriber.'}
    for round_id in (1, 2):
        for scenario in ('hidden50', 'visible30'):
            for variant in (('baseline', 'candidate') if round_id == 1 else ('candidate', 'baseline')):
                binary = baseline if variant == 'baseline' else candidate
                print(f'Running {variant} {scenario} round {round_id}', flush=True)
                log = output / f'{variant}-{scenario}-{round_id}.log'
                with log.open('w') as stream:
                    subprocess.run([str(case), str(binary), variant, scenario, str(round_id),
                                    str(args.seconds), '3', str(output), 'linux'],
                                   stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=180)
                total = float((output / variant / scenario / f'r{round_id}' / 'total-cpu.txt').read_text())
                report['cases'].append({'variant': variant, 'scenario': scenario, 'round': round_id, 'cpu': total})
                (output / 'progress.json').write_text(json.dumps(report, indent=2) + '\n')
    report['comparison'] = {}
    for scenario in ('hidden50', 'visible30'):
        means = {variant: sum(case['cpu'] for case in report['cases'] if case['variant'] == variant and case['scenario'] == scenario) / 2
                 for variant in ('baseline', 'candidate')}
        before, after = means['baseline'], means['candidate']
        report['comparison'][scenario] = {**means, 'change_percent': (after - before) / before * 100 if before else None,
                                         'passed': before > 0 and after > 0 and not (after > before * 1.25 and after - before > .5)}
    report['ok'] = all(result['passed'] for result in report['comparison'].values())
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['comparison']), flush=True)
    if not report['ok']:
        raise SystemExit('Native CPU comparison exceeded upstream limits')


if __name__ == '__main__':
    main()
