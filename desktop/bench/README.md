# 本地语义搜索原型

使用 20 份合成中英文文件、17 个有目标文件的查询和 3 个无匹配查询。字面对照按文件名和正文做连续子串匹配。语义原型在 Windows CPU 上对每份短文档生成一个向量，再按余弦相似度排序。运行时只读本地模型文件，禁止远程模型请求。原型依赖与模型均在桌面安装包之外。

## 复现

在仓库根目录运行以下 PowerShell 命令，准备独立的原型目录。模型文件使用 [Xenova 的 ONNX 转换版本](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726/onnx)，编码采用 [Multilingual E5 的检索方式](https://huggingface.co/intfloat/multilingual-e5-small)。

```powershell
npm install --prefix artifacts/semantic-bench --save-exact @huggingface/transformers@3.8.1
$modelPath = 'artifacts/semantic-bench/models/Xenova/multilingual-e5-small'
$null = New-Item -ItemType Directory -Force -Path "$modelPath/onnx"
$source = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726'
foreach ($file in @('config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model_quantized.onnx')) {
  curl.exe --fail --location --output "$modelPath/$file" "$source/$file"
  if ($LASTEXITCODE -ne 0) { throw "Model download failed: $file" }
}
node desktop/bench/semantic.mjs artifacts/semantic-bench
```

## Windows 初测

| 查询类型 | 样本数 | 字面命中 | 语义首位命中 | 语义前三命中 |
| --- | ---: | ---: | ---: | ---: |
| 精确字面 | 4 | 4 | 4 | 4 |
| 同语种改写 | 8 | 0 | 8 | 8 |
| 跨语言 | 5 | 0 | 3 | 3 |

在 Intel Core Ultra 7 155H 上，模型和分词文件合计约 135 MB。首次加载约 1.15 秒，20 份短文档批量编码约 322 毫秒。加载后，20 条测试查询的编码和排序用时中位数为 7.7 毫秒，P95 为 11.1 毫秒。这些数字来自一轮小样本测试，适用于这组短文档。

「冬天的开销计划」把「第四季度预算」排到首位，领先第二名的分数差很小。两个跨语言问题的正确文档分别排在第 8 和第 11 位。三个无匹配问题仍被排出了首位结果，其中房贷问题得到的首位分数高于部分正确匹配。下一轮需要扩大无匹配和近似干扰样本，验证何时应该显示语义候选，以及何时应提示找不到可信结果。
