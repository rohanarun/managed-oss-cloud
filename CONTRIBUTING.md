# Contributing

Contributions are welcome through focused pull requests.

For a new catalogue application, include its upstream repository, licence, pinned release, minimum memory budget, required services, persistent paths, health check, backup and restore procedure, upgrade procedure, and whether it can safely share a host.

Run the validation suite before submitting:

```sh
npm test
npm run typecheck
npm run build
terraform -chdir=infra/google-cloud fmt -check
terraform -chdir=infra/google-cloud validate
```
