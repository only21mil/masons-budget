# Recent unlock and profile switching

I8 removes the immediate duplicate authentication prompt after unlocking the app. A successful app unlock grants one adult-to-adult switch for **15 seconds**, measured from LocalAuthentication's success callback using system uptime. At 15 seconds it has expired. The grant belongs to the adult profile that was unlocked, stays in memory, and is consumed before the switch. Returning to that profile does not restore it.

Only a successful `.deviceOwnerAuthentication` evaluation initiated by the lock screen qualifies. Device passcode fallback qualifies under that same policy. An unlocked Boolean, disabled app lock, a successful profile-switch prompt, and merely being able to evaluate the policy never qualify. There is no new setting.

| Event | Behavior |
| --- | --- |
| Adult unlock, then choose the other adult before expiry | Switch once without another prompt. |
| Expired grant or another switch | Use the existing authentication prompt. |
| Adult selects a child | Clear the grant and authenticate the switch. |
| Child selects another profile | Deny before attempting reuse or authentication, using `allowedSwitchTargets`. |
| Failure, cancellation, unavailable policy, or closed picker during a prompt | Clear the attempt and grant; remain on the current profile or lock screen. |
| Any profile change, including a round trip | Clear the grant and invalidate pending attempts. |
| Inactive with no app authentication pending | Clear the grant. |
| Inactive while our LocalAuthentication evaluation is pending | Preserve only that attempt. Hold a successful result until active; preserve its original success time. |
| Background, device lock/protected-data loss, or session lock | Invalidate every attempt and grant immediately. Relock the app when app lock is enabled. Returning active cannot revive a callback. |
| Relaunch or app-lock preference change | No grant survives. |

The pending-prompt exception accommodates the system authentication UI's inactive transition. It never applies to a background transition. Attempt IDs, the source profile, current scene state and the allowed-target check must all remain valid when committing a result. A switch updates the state before persistence, so profile ABA cannot revive an old attempt. No callback commits a switch while inactive.

This is the scoped implementation decision under Victor's approved Fable usage-limit exception. The existing household visibility helpers remain authoritative and unchanged. Source/state verification does not establish native biometric interaction or visual QA; the final I8 candidate requires independent review and ordinary Apple CI.
