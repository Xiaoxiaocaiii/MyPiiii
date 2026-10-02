# Scenarios

`scenarios` is the extension boundary for one task family at a time. The current
`repo-qa@v1` scenario provides input adaptation and output validation for the fixed
`repo-qa-structure@v1` 20-case evaluation dataset.

Scenario code may define allowed tools and output contracts, but it must not modify the
Runtime state machine or introduce dynamic plugin loading.
