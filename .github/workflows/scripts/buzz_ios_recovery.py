#!/usr/bin/env python3
"""Sign the fixed preserved Buzz iOS artifact, with bounded public diagnostics."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

SCRIPT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ios_release', SCRIPT / 'buzz_ios_release.py')
ios = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ios)
SOURCE = '038e8ae4f33387f2b5a299c1af54b1a4404c5f94'
VERSION, NUMBER = '0.5.9', '1'
BUILD_RUN, BUILD_ATTEMPT = '34247966654', '1'
BUILD_WORKFLOW = '70e628c301f99533062645dc83274df5ac4ec07c'
ARTIFACT = 10065006053
BUILD_JOB = 102134753120
ZIP_SHA = 'd51782a7540d3b5138902528b2d9ed9ee0557274fa55e73f5a880ca163beb634'
ARCHIVE_SHA = '4290211f9eba83e0e8017deb5fb45942d96ec3566434da451a3ffd3283977b52'
RECEIPT_SHA = '8c286f34d0fdc187b361073d14b987e2cf158475038c53f975a0d76dad6989b4'
CURRENT_PHASE = 'initialization'
SECURITY_PHASES = {'create-keychain', 'unlock-keychain', 'import', 'set-key-partition-list', 'list-keychains'}
NATIVE_FAILURES = {
    b'the specified item could not be found in the keychain': 'KEYCHAIN_ITEM_NOT_FOUND',
    b'errsecinternalcomponent': 'SECURITY_INTERNAL_COMPONENT',
    b'unable to build chain': 'CERTIFICATE_CHAIN_FAILURE',
    b'cssmerr_tp_not_trusted': 'CERTIFICATE_NOT_TRUSTED',
    b'user interaction is not allowed': 'USER_INTERACTION_DISALLOWED',
    b'mac verification failed during pkcs12 import': 'P12_PASSWORD_OR_FORMAT_FAILURE',
    b'bundle format unrecognized': 'BUNDLE_FORMAT_UNRECOGNIZED',
    b'resource fork, finder information': 'RESOURCE_METADATA_DISALLOWED',
    b'a sealed resource is missing or invalid': 'RESOURCE_SEAL_INVALID',
    b'code object is not signed at all': 'CODE_UNSIGNED',
    b'unsealed contents present': 'UNSEALED_BUNDLE_CONTENTS',
    b'invalid entitlements': 'ENTITLEMENTS_INVALID',
    b'certificate has expired': 'CERTIFICATE_EXPIRED',
}


class RecoveryError(Exception):
    pass


def event(status, **fields):
    row = {'phase': CURRENT_PHASE, 'status': status, **fields}
    # Values are fixed phases/classifications, counts, status and assertion IDs.
    # No argv, environment, tool output, keychain path or artifact path is logged.
    text = json.dumps(row, sort_keys=True)
    print(text, flush=True)
    output = Path('signed-ios')
    if output.is_dir() and not output.is_symlink():
        with (output / 'recovery-events.jsonl').open('a') as stream:
            stream.write(text + '\n')


def checked(condition, message):
    if not condition:
        event('failed', classification='VALIDATION_FAILED', assertion_id=hashlib.sha256(message.encode()).hexdigest())
        raise RecoveryError('validation failed')


def phase(argv):
    tool = Path(argv[0]).name
    if tool == 'security' and argv[1:2] == ['-i']:
        return CURRENT_PHASE
    operations = {'security': {'set-keychain-settings', 'find-identity', 'find-certificate', 'cms', 'list-keychains', 'delete-keychain'},
                  'codesign': {'--force', '--verify', '--display'}, 'openssl': {'x509'}, 'lipo': {'-archs'},
                  'ditto': {'-c'}, 'xcrun': {'altool'}}
    checked(tool in operations and len(argv) > 1 and argv[1] in operations[tool], 'unexpected trusted native operation')
    return tool + '.' + argv[1].lstrip('-')


def traced_run(argv, *, output=None, input_data=None, extra=None, confidential=False):
    global CURRENT_PHASE
    checked(output is None, 'raw command output capture forbidden')
    CURRENT_PHASE = phase(argv)
    event('started')
    try:
        result = subprocess.run(argv, input=input_data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=ios.common.clean_env(extra), check=False)
    except Exception:
        event('failed', classification='NATIVE_SPAWN_FAILED')
        raise RecoveryError('native spawn failed') from None
    if result.returncode:
        data = (result.stdout + result.stderr).lower()
        classes = sorted({name for match, name in NATIVE_FAILURES.items() if match in data})
        event('failed', classification='TRUSTED_COMMAND_FAILED', exit_code=result.returncode,
              native_classifications=classes or ['UNCLASSIFIED_NATIVE_FAILURE'])
        raise RecoveryError('native command failed')
    event('passed')
    return result.stdout


original_security = ios.common.security_command


def traced_security(words):
    global CURRENT_PHASE
    checked(words and words[0] in SECURITY_PHASES, 'unexpected trusted security operation')
    CURRENT_PHASE = 'security.' + words[0]
    return original_security(words)


def request(path):
    token = os.environ.get('GH_TOKEN', '')
    checked(token, 'provider read token missing')
    # All paths below are fixed by this trusted driver; redirects are refused.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    req = urllib.request.Request('https://api.github.com/repos/only21mil/masons-budget/' + path,
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as response:
        raw = response.read(2_000_001)
    checked(len(raw) <= 2_000_000, 'provider response exceeds bound')
    return json.loads(raw)


def provenance():
    run = request('actions/runs/' + BUILD_RUN)
    checked(run['id'] == int(BUILD_RUN) and run['run_attempt'] == int(BUILD_ATTEMPT)
            and run['workflow_id'] == 352536614 and run['head_sha'] == BUILD_WORKFLOW
            and run['event'] == 'workflow_dispatch' and run['status'] == 'completed', 'original run differs')
    jobs = request('actions/runs/' + BUILD_RUN + '/attempts/' + BUILD_ATTEMPT + '/jobs?per_page=100')
    checked(jobs['total_count'] == len(jobs['jobs']), 'incomplete original job inventory')
    build = [job for job in jobs['jobs'] if job['name'] == 'build']
    checked(len(build) == 1 and build[0]['id'] == BUILD_JOB and build[0]['conclusion'] == 'success',
            'original unsigned build did not succeed')
    artifact = request('actions/artifacts/' + str(ARTIFACT))
    checked(artifact['id'] == ARTIFACT and not artifact['expired']
            and artifact['name'] == 'buzz-ios-unsigned-' + SOURCE
            and artifact['digest'] == 'sha256:' + ZIP_SHA
            and artifact['workflow_run']['id'] == int(BUILD_RUN)
            and artifact['workflow_run']['head_sha'] == BUILD_WORKFLOW, 'original artifact differs')
    receipt = {'source_run': BUILD_RUN, 'source_attempt': BUILD_ATTEMPT, 'source_workflow': BUILD_WORKFLOW,
               'artifact_id': ARTIFACT, 'artifact_zip_sha256': ZIP_SHA, 'source_build_job': build[0]['id'],
               'current_run': os.environ['GITHUB_RUN_ID'], 'current_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
               'current_workflow': os.environ['GITHUB_SHA']}
    Path('ios-recovery-provenance.json').write_text(json.dumps(receipt, indent=2) + '\n')


def arguments():
    return argparse.Namespace(source=SOURCE, version=VERSION, build_number=NUMBER, input=Path('unsigned'),
        build_origin=ios.BuildOrigin(BUILD_RUN, BUILD_ATTEMPT, BUILD_WORKFLOW))


def verify_input(args):
    proof = json.loads(Path('ios-recovery-provenance.json').read_text())
    checked(proof['current_run'] == os.environ['GITHUB_RUN_ID'] and proof['current_attempt'] == os.environ['GITHUB_RUN_ATTEMPT']
            and proof['current_workflow'] == os.environ['GITHUB_SHA'] and proof['artifact_id'] == ARTIFACT
            and proof['source_run'] == BUILD_RUN and proof['source_attempt'] == BUILD_ATTEMPT
            and proof['source_workflow'] == BUILD_WORKFLOW and proof['artifact_zip_sha256'] == ZIP_SHA
            and proof['source_build_job'] == BUILD_JOB,
            'current recovery provenance differs')
    checked(ios.common.sha(args.input / 'unsigned-ios.app.tar.gz') == ARCHIVE_SHA
            and ios.common.sha(args.input / 'build-ios.json') == RECEIPT_SHA, 'preserved unsigned bytes differ')
    ios.check_build(args)


def main():
    global CURRENT_PHASE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['provenance', 'prepare', 'sign', 'upload', 'cleanup'])
    action = parser.parse_args().action
    checked(os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'hosted recovery VM required')
    ios.require = ios.common.require = checked
    ios.run = ios.common.run = traced_run
    ios.common.security_command = traced_security
    CURRENT_PHASE = action
    if action == 'provenance':
        provenance()
    elif action == 'cleanup':
        ios.cleanup()
    else:
        args = arguments()
        verify_input(args)
        getattr(ios, action)(args)
    event('passed', action=action)


if __name__ == '__main__':
    try:
        main()
    except RecoveryError:
        sys.exit(1)
    except Exception:
        event('failed', classification='UNEXPECTED_OPERATION_FAILURE')
        sys.exit(1)
