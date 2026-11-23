ONNX Runtime 1.31.1's license and third-party notices, for the image's
`/opt/background` (the Dockerfile's `background` stage), beside ONNX Runtime
Web 1.31.1 from npm, which ships neither.

They're the files `onnxruntime/LICENSE` and `onnxruntime/ThirdPartyNotices.txt`
of its Python wheel on PyPI, unchanged:
https://files.pythonhosted.org/packages/c4/c6/1995e04cc964c6abac426f59525b41c31f766c9392cabfb1e67c51718823/onnxruntime-1.31.1-cp311-cp311-win_arm64.whl
(SHA-256 93800007a7023b3ab26ad72e6463d0d57d84ead49a2f6341954d91438e046bc0,
as PyPI gives it). The project's GitHub repository, where the Dockerfile
fetched them by tag before, answers 404 (checked 23 November 2026).

- LICENSE: SHA-256 c250d6278f0b47a6439fb7592b08b58a55eb9f535aa49a1db63211c3f982b674
- ThirdPartyNotices.txt: SHA-256 c53a76501ef60db6f865f20599f220761201ac4057683acefdab37d861b86622

Bump them with `ONNX_WEB_VERSION`.
