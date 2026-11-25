name: Provider Adapter Request
description: Request or propose a new LLM power-source adapter
labels: ["enhancement"]
body:
  - type: input
    id: provider
    attributes:
      label: Provider / API Name
      placeholder: e.g. Mistral, Bedrock, Cohere
    validations:
      required: true
  - type: textarea
    id: details
    attributes:
      label: API Details & Requirements
      description: Auth scheme, streaming format, and tool-calling shape.
    validations:
      required: true
