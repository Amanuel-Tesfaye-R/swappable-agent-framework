name: Bug Report
description: Report a bug in the Swappable Agent Framework SDK or CLI
labels: ["bug"]
body:
  - type: textarea
    id: description
    attributes:
      label: Problem Description
      description: Clear summary of the issue.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to Reproduce
      description: Minimal config or script to reproduce.
    validations:
      required: true
