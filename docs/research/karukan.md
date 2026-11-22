# karukan のかな漢字変換は語の区切りを出さない

2026年11月22日の調査メモ。入力中の付箋で、AI が黙って前提を置く語に下線を引く仕組み（[#1][itb-1]）について、別の解き方の手がかりを karukan に探した。karukan は、小さな言語モデルで周りの文を読みながらかな漢字変換をする IME である。

読んだのは karukan の [`2f0a00a`][k-commit]（2026-11-21）のコードと文書、karukan の PR、Hugging Face の jinen モデルカードとメタデータ、上流の zenzai の文書である。karukan のビルドもコードの実行もしていない。下の数値はすべて出典に書かれた値か、公開ファイルを読んで数えた値である。

前半の「事実」は出典を付けて書いた。後半の「intra-turn-board への示唆」は私の推測で、確かめるために測ることを添えた。

## 要点

- karukan のモデル（jinen）は、カタカナの読みと左文脈を受け取り、変換後の文字列を1本まるごと生成する。語や文節の区切りはどこにも出さない。ライブ変換の Chunk は、最大30文字を文字種で切った内部の単位で、語ではない。Chunk や IME の区切りを下線の単位に流用する案は成り立たない。
- モデルが読む文脈は、カーソルの左にある現在行の既定10文字と、設定したペルソナ（最大25文字）だけである。右文脈は取得しているが表示に使うだけで、モデルには渡らない。
- jinen は日本語専用である。語彙は32,000の BPE で、ハングルのトークンを1つも持たない。ja/en/zh/ko を1つで扱うモデルの代わりにはならない。
- 転用できそうなのは仕組みの方だ。(1) カーソルより左の確定した範囲を固定し、(文, 文脈) をキーに結果をキャッシュする。(2) 文章を生成させず、尤度で採点する。(3) 文脈をプロンプトの先頭に固定し、KV キャッシュを使い回す。
- 打鍵ごとの変換の遅延は、M2・4スレッドで平均6.4 ms、p99 で12.6 ms だった。出力が数トークンの変換で、前回の出力を下書きとして検証する最適化を含む数字である。下線の判定にそのまま当てはめられる値ではない。

## 事実

### 構成

- karukan は Linux（fcitx5）と macOS 向けの日本語入力システムである。Rust のエンジン（karukan-engine）、IME の状態機械（karukan-im）、fcitx5 の C FFI とアドオン、macOS の Swift フロントエンドから成る（[README L17-26][k-readme-structure]）。
- macOS では、Swift 側が `karukan-imserver` を子プロセスとして起動し、stdio の JSON-RPC で操作する。IME の状態はすべてサーバー側が持つ（[CLAUDE.md L13][k-claude-13]、[CLAUDE.md L175][k-claude-175]）。
- 変換候補には、モデルのほかに学習キャッシュ、ユーザー辞書、SudachiDict から作ったシステム辞書、Mozc から移植したリライターが加わる（[README L28-38][k-readme-features]）。

### モデルと配布

既定で6つのモデルが定義されている。`model` が通常のモデル、`light_model` が軽量モデルで、既定の動作（adaptive）では両方を読み込む（[default.toml L50-77][k-default-models]、[configuration.md L140-150][k-conf-strategy]）。

| モデルキー | アーキテクチャ | パラメータ数（文書） | パラメータ数（GGUF メタデータ） | 量子化 | ファイル | Acc@1 NFKC（文書） |
|---|---|---:|---:|---|---:|---:|
| `jinen-v2-small-q8`（既定） | Qwen3 | 109M | 109,533,696 | Q8_0 | 117.2 MB | 86.5% |
| `jinen-v2-xsmall-q8`（軽量の既定） | Qwen3 | 36M | 35,660,544 | Q8_0 | 38.7 MB | 79.0% |
| `jinen-v2-small-q5` | Qwen3 | 109M | 109,533,696 | Q5_K_M | 81.1 MB | 86.0% |
| `jinen-v2-xsmall-q5` | Qwen3 | 36M | 35,660,544 | Q5_K_M | 28.3 MB | 79.0% |
| `jinen-v1-small-q5` | GPT-2 | 90M | 110,420,736 | Q5_K_M | 88.5 MB | 76.5% |
| `jinen-v1-xsmall-q5` | GPT-2 | 26M | 35,825,152 | Q5_K_M | 31.2 MB | 71.0% |

文書の列は [configuration.md L62-71][k-conf-models] による。GGUF メタデータとファイルの大きさは Hugging Face の API（[v2-small][hf-api-v2s]、[v2-xsmall][hf-api-v2x]、[v1-small][hf-api-v1s]、[v1-xsmall][hf-api-v1x]）の値である。v1 の2つは、文書のパラメータ数と GGUF の総数が合わない（「確認できなかったこと」を参照）。

- モデルは Hugging Face の `togatogah/jinen-*` に置かれている。初回起動時にバックグラウンドで取得し、取得中もかな入力と辞書変換は動く。ネットワークを使うのはこの初回だけである（[README L40][k-readme-note]）。取得済みのファイルはネットワークに問い合わせずに使う。同じファイル名のまま更新しても反映されないので、更新時はファイル名を変える（[CLAUDE.md L199][k-claude-199]）。
- 既定の2モデルの GGUF は合わせて約156 MB で、それぞれのリポジトリの `tokenizer.json`（各2.0 MB）が加わる（上の API の値から計算）。システム辞書 `dict.tgz` は別配布で、リリース v0.1.0 では74.1 MB である（[リリース][k-release]、[dictionary.md L8-30][k-dict-system]）。
- Q8_0 を既定にした理由は、ファイルが大きい代わりに、複数のトークンをまとめて評価する計算が軽いことである。下書きの検証もビームサーチも、1回に複数トークンを評価する（[CLAUDE.md L198][k-claude-198]、[configuration.md L71][k-conf-models]）。この変更で、打鍵ごとの変換は27%、Space 変換は36〜47%減った（[PR #153][k-pr153]）。
- トークナイザーは llama.cpp 内蔵のものを使わず、HuggingFace の `tokenizers` crate で外部の `tokenizer.json` を読む（[karukan-engine/Cargo.toml L37-38][k-engine-cargo]）。
- jinen-v2-small の `tokenizer.json` は、語彙32,000の BPE と追加トークン263個（`<pad>` `<unk>` `<s>` `</s>` とバイトフォールバックの `<0x00>` など）から成る。正規化は NFKC、事前分割は Digits である（[tokenizer.json][hf-v2s-tok] を jq で読んだ値）。語彙を文字種で数えると、ハングルを含むトークンは0、ラテン文字だけのトークンは1,877、ひらがなかカタカナを含むトークンは14,183、漢字だけのトークンは12,559だった（同じファイルを grep で数えた値）。jinen-v1 の `tokenizer.json` は2,047,609バイト、v2 は2,047,498バイトで、大きさがほぼ同じである（[v1-small の API][hf-api-v1s]、[v2-small の API][hf-api-v2s]）。

### 推論の実行

- llama.cpp を、Rust バインディング `llama-cpp-2` 0.1.161 から呼ぶ（[karukan-engine/Cargo.toml L27-28][k-engine-cargo]、[Cargo.lock L1849-1851][k-cargo-lock]）。
- 推論は CPU だけで行う。`n_gpu_layers = 0` に加えて、デバイス一覧を空にしている。既定のデバイス一覧では、llama.cpp がコンテキストを作るたびに GPU バックエンドを付ける。macOS ではそのたびに Metal を初期化し、どの層も使わない 35 MiB のバッファを GPU に確保していた。GPU をゲームが占有していると、その後ろで待って入力が止まった。コードのコメントには「jinen-v2-xsmall を Metal に全部載せると 12 ms、CPU では 7 ms」とある（[llamacpp.rs L300-317][k-llama-load]）。
- IME の変換で使うコンテキスト長は256トークンである（[llamacpp.rs L246-250][k-llama-nctx]）。推論スレッド数の既定は4で、0にすると全コアを使う（[default.toml L56-57][k-default-threads]）。
- 読み込んだモデルと、貪欲生成用の常駐コンテキストは、プロセス内で共有する。fcitx5 のように入力欄ごとにエンジンを作るフロントエンドでも、モデル1つにつきセッションは1つである（[CLAUDE.md L200][k-claude-200]）。

### プロンプトの形式

- プロンプトは `{左文脈}{カタカナの読み}` で、全体を NFKC 正規化する。モデルは `` の後ろに変換結果を生成する（[backend.rs L48-58][k-backend-prompt]、[kanji/mod.rs L13-16][k-kanji-tokens]）。ひらがなの読みは、プロンプトに入れる前にカタカナへ変える（[backend.rs L119-123][k-backend-convert]）。
- この形式は、azooKey の zenz-v3 のトークン配置を参考にしている（[karukan-engine/README.md L119-131][k-engine-readme-format]）。zenz-v3 は、`` に続けたプロフィールを考慮するよう学習済みで、`` でトピック、`` でスタイル、`` で設定も実験的に扱う。zenz-v3.2 は `` で右文脈も扱う（[zenzai.md L41-44][zenzai-terms]）。jinen が使うのは `` から `` の3つだけである。
- 1回の変換で生成するのは最大50トークンで、前後の空白を落としたものを候補にする。何も出なければ読みをそのまま返す（[backend.rs L45-46][k-backend-max]、[backend.rs L125-168][k-backend-convert]）。
- モデルカードは、NFKC 正規化を必須とし、使わないと精度が大きく落ちるとしている。生成は必ず貪欲（`--temp 0 --top-k 1`）で行うよう書いている（[jinen-v2-small.gguf のカード][hf-v2s]）。karukan は、候補を複数出すときにはビームサーチを使う（次の節）。

### 候補の生成と順位

**1候補（ライブ変換）は貪欲生成である。** 常駐コンテキストに前回のプロンプトと出力を残し、前回と共通の接頭辞より後ろだけを decode する。さらに、前回の出力を下書きとして同じバッチに載せ、各位置でモデル自身の argmax と一致する間だけ採用する。下書きを出すのは、プロンプトの違いが末尾4トークン以内のとき（同じ読みの末尾を編集したとき）だけである（[llamacpp.rs L90-96][k-llama-draft]、[llamacpp.rs L524-656][k-llama-greedy]）。採用されるトークンはすべてモデルの argmax なので、下書きが変えるのは decode の回数だけである。打鍵あたりの decode は6.4回から2.3回に減った（[CLAUDE.md L200][k-claude-200]、[PR #153][k-pr153]）。

この最適化の前提は、コードのコメントと PR に書かれている。1回の decode は、運ぶトークンが1個でも20個でもモデルの重み全体をメモリから読む。1トークンずつ生成すると、その固定費を出力トークンの数だけ払う（[llamacpp.rs L526-541][k-llama-greedy]、[PR #153][k-pr153]）。

**複数候補（Space 変換）はビームサーチである。** 各ビームを上位 max(ビーム幅, 4) トークンに広げ、log-softmax の累積で上位をビーム幅だけ残す。終わったビームがビーム幅に達し、残りがどれも最良の完了ビームに勝てなくなったら止める。最後は累積スコアの順に並べる（[llamacpp.rs L772-925][k-llama-beam]、[llamacpp.rs L1025-1099][k-llama-beam-helpers]）。スコアは対数確率の和だけで、長さによる補正はない（同じ箇所のコード）。ビームの KV キャッシュは1つの統合バッファに置く。llama.cpp の既定では系列ごとに独立した KV を持ち、系列間のコピーが KV 全体の memcpy になるためである（[llamacpp.rs L830-840][k-llama-beam]）。

**モデルの使い分け。** 既定の adaptive では次のように動く（[strategy.rs L49-90][k-strategy]）。

- ライブ変換は通常のモデルの貪欲生成で行う。直前の呼び出しが `max_latency_ms`（既定100 ms）を超えていたら、軽量モデルの貪欲生成に切り替える（[default.toml L42-43][k-default-latency]）。
- Space 変換は、通常のモデルの貪欲生成と、軽量モデルのビーム（幅3）を2つのスレッドで並列に走らせる。通常のモデルの結果を先頭にし、重複を除いてつなぐ（[model.rs L228-307][k-model-parallel]、[model.rs L333-346][k-model-merge]）。候補数の設定は9だが、モデルからの候補はビーム幅3で頭打ちになる（[default.toml L7-8, L40-41][k-default-head]、[strategy.rs L69-83][k-strategy]）。
- Space 変換でビームをかけるのは、読みの末尾から `beam_chars`（既定30文字）に収まる Chunk だけである。それより前はライブ変換と同じ1位の結果を使う。候補一覧の先頭は、ライブ変換で表示していた文字列と一致する（[model.rs L348-387][k-model-span]、[CLAUDE.md L214-215][k-claude-214]）。

**制限時間。** モデル1回の呼び出しには制限時間があり、ライブ変換では `timeout_ms`（既定500 ms）、Space 変換ではその4倍である。時間を超えたモデルは2秒休み、続けて超えるたびに休みを倍にする（最長60秒）。休んでいる間は、ひらがなと辞書の候補で入力を続ける（[guard.rs L68-76][k-guard]、[configuration.md L161-175][k-conf-heavy]）。

**キャッシュ。** モデルの結果は、(カタカナの読み, 左文脈, モデルの役割, ビーム幅) をキーにした LRU（既定4,096件）に入る（[cache.rs L20-31][k-cache-key]、[cache.rs L49][k-cache-cap]）。

**辞書との組み合わせ。** モデルの候補と辞書の候補を一緒に採点し直すことはしない。出どころの順に並べ、重複を除くだけである。順は、学習キャッシュ、ユーザー辞書の完全一致、モデル、システム辞書の完全一致、前方一致の辞書候補、ひらがなとカタカナ、日付とバージョン、リライターの候補である（[conversion.rs L309-450][k-conv-build]、[dictionary.md L42-50][k-dict-priority]）。

**尤度での採点はオフラインで使う。** `NllScorer` は (読み, 表記) の組を1回の decode に載せ、表記の1文字あたりの負の対数尤度を返す。左文脈は空である（[llamacpp.rs L1208-1290][k-llama-nll]）。これを使うのは辞書を作る `sudachi-dict --model-scores` で、SudachiDict の候補の並び順を決める（[sudachi_dict.rs L1-8][k-sudachi]、[karukan-cli/README.md L82-109][k-cli-sudachi]）。入力中の変換では使わない。

### 周りの文の取り込み

- **fcitx5。** エンジンが空の状態でキーが押されたときに取り込む。アプリが SurroundingText の機能を持っていれば、その文とカーソル位置をエンジンに渡す。持っていなければ空にする（[karukan.cpp L153-158][k-fcitx-capture-key]、[karukan.cpp L246-256][k-fcitx-capture]）。入力欄が有効になったときにも取り込む（[karukan.cpp L299-302][k-fcitx-activate]）。
- **macOS。** 変換中の文字が無く、機能キーや移動キーでもないときに取り込む。`selectedRange` で得たカーソルから左の 40 UTF-16 単位を `string(from:actualRange:)` で読む。読めなければ空にする。古い位置の文脈を残すより、文脈が無い方がましだという方針である（[KarukanInputController.swift L75-84][k-mac-capture-key]、[KarukanInputController.swift L205-247][k-mac-capture]）。同じ箇所のコメントによれば、Cocoa のテキストビューは対応するが、Electron、Chromium、ターミナルはほぼ対応しない。
- **エンジン側の整形。** カーソルで左右に分け、左は最後の改行より後ろ（現在の行）だけを残す。空白だけの左文脈は捨てる。左は末尾から `context_chars`（既定10文字）、右は先頭から同じ文字数に切る（[engine/mod.rs L400-462][k-engine-surrounding]、[default.toml L9-12][k-default-context]）。`use_context = false` にすると文脈の文字数を0にする（[types.rs L138-142][k-types-context]）。
- **モデルに渡るのは左だけである。** モデルへの文脈は左文脈から作る（[display.rs L396-411][k-display-api]）。プロンプトを作る関数も、文脈の引数を1つしか持たない（[backend.rs L48-58][k-backend-prompt]）。右文脈は補助テキストの表示に使う（[display.rs L115-146][k-display-context]）。
- **Chunk ごとの文脈。** 各 Chunk の左文脈は、エディタの左文脈に、それより前の Chunk の変換結果をつないで `context_chars` に切ったものである（[chunk/mod.rs L143-158][k-chunk-lctx]）。
- モデルカードの AJIMEE-Bench の数値は、左文脈64文字で測っている（[jinen-v2-small.gguf のカード][hf-v2s]）。karukan の既定の10文字とは条件が違う。

### ライブ変換と Chunk

- **打鍵ごとに全体を区切り直す。** ライブ変換は、打鍵のたびに入力中の読み全体を Chunk に区切り直し、すべての Chunk をモデルに通す。読みと左文脈が変わらない Chunk はキャッシュに当たり、モデルを呼ばない（[chunk/mod.rs L1-11][k-chunk-header]、[chunk/mod.rs L24-64][k-chunk-auto]）。
- **区切りの位置。** Chunk が切れるのは次の3か所である（[split.rs L15-30][k-split-japanese]、[split.rs L102-146][k-split-group]、[chunking.md L38-81][k-chunking-where]）。
  - 長さが `chunk_chars`（既定30文字）に達したところ
  - 利用者が Ctrl+J で入れた区切り
  - 日本語以外の文字が、1つの Chunk に残せる数を超えたところ
- **日本語と日本語以外の扱い。** ここでの「日本語」は、ひらがな、長音符を含むカタカナ、漢字で、中黒は含まない。1つの Chunk に残せる数の既定は、記号が1、数字が0、英字が0である。記号が1なのは、「おい、」と打った時点で「老、」に固まるのを防ぐためである。日本語を含まない Chunk はモデルに渡さず、打ったまま表示する。数字の桁が欠けたり増えたりするのを防ぐためである（[chunking.md L20-22][k-chunking-why]、[chunking.md L38-81][k-chunking-where]）。
- **短い入力は1つの Chunk になる。** 30文字以下で数字も英字も無い入力は1つの Chunk で、打鍵のたびに全体を変換し直す。コードのコメントも、これをよくある場合としている（[chunk/mod.rs L24-30][k-chunk-auto]）。
- **何がいつ固まるか。** カーソルより左に区切りができると、その左の Chunk は読みも左文脈も変わらなくなる。そのためキャッシュに当たり続け、表示が固まる。途中を編集すると、それより右の Chunk は左文脈が変わるので変換し直す（[CLAUDE.md L204-206][k-claude-204]）。Ctrl+J の区切りは編集に合わせて動き、確定・キャンセル・全消去で消える（[chunking.md L28-36][k-chunking-manual]）。末尾に1つだけ残った `n` は、ライブ変換では「ん」として先に変換する（[configuration.md L92][k-conf-live]）。
- **Chunk を作った動機。** 文書は、入力を進めると前半の表示が変わる例を挙げている。「Rust言語」が、続きを打つと「ラスト言語が私は」になる。「私の名前は」が「わたしの名前は中野です」になる。同じ読みを漢字・カタカナ・英語のどれにするかは、後ろの文脈で変わるためである（[chunking.md L9-18][k-chunking-why]）。
- **区切りは外に出さない。** Chunk は内部の区切りで、画面には線などを出さない（[chunking.md L24][k-chunking-internal]）。フロントエンドに渡す変換中の文字には、入力中なら全体に下線1つ、変換中なら全体に強調1つの属性しか付けない（[preedit.rs L95-115][k-preedit]、[display.rs L54][k-display-preedit]、[conversion.rs L183-192][k-conv-preedit]）。
- **文節や品詞は持たない。** karukan は文節や品詞を持たない。Mozc から単漢字変換を移植したときも、文節と品詞が要る名詞接頭辞の挿入は移植していない（[CLAUDE.md L210][k-claude-210]）。
- **確認する方法。** 編集中の Chunk の読みと「使った文字数 / 上限」は補助テキストに出る。デバッグモードでは、別候補を出す範囲、推論時間、モデル名、モデルに渡した左文脈も出る（[chunking.md L83-103][k-chunking-aux]、[configuration.md L117-134][k-conf-verbose]）。

### ペルソナと学習

- **ペルソナ。** `config.toml` の `[conversion] persona` に書いたキーワードを、モデルに渡す左文脈の先頭に毎回付ける。間には半角スペースを1つ入れる。値は起動時に1度だけ、NFKC 正規化、前後の空白の除去、末尾25文字への切り詰めをする。付ける場所はモデル呼び出しの唯一の入口なので、ライブ変換にも Space 変換にも効き、キャッシュのキーにも入る（[persona.md L1-21][k-persona]、[engine/mod.rs L99][k-engine-persona-chars]、[engine/mod.rs L206-217][k-engine-persona-norm]、[model.rs L16-44][k-model-persona]）。
- **ペルソナの効果。** 文書にある例は2つだけである。「プログラミング」と書くと、「くろーど」が「クロード」から「Claude」に、「らすと」が「ラスト」から「Rust」に変わる。英語で「programming」と書くと、英語の直前文脈になるので「claude」「last」のように小文字に寄る（[persona.md L10-20][k-persona]）。量で測った評価は見つからなかった。
- **zenz-v3 との違い。** ペルソナは、azooKey-Desktop の「変換プロフィール」に当たる機能として足された。PR にある azooKey の調査によれば、zenz-v3 はプロフィールを専用トークン `` の欄として左文脈より前に入れる。プロンプトの最前部に置くので、KV キャッシュの共通接頭辞として残り、実質1度しか decode しない。jinen はこの専用トークンを学習しておらず、「プロフィール:」のようなラベルを理解できる大きさでもない。そこで karukan はラベルを付けずに前に置くだけにした（[PR #92][k-pr92]）。
- **学習。** 学習は、選んだ変換を (読み, 表記, 回数, 最終使用時刻) の TSV に記録するキャッシュである。スコアは `recency * 10 + ln(1 + frequency)` で、最大10,000件、50文字を超える表記は記録しない（[learning.rs L1-5][k-learning-header]、[learning.rs L309-317][k-learning-score]、[configuration.md L182-195][k-conf-learning]）。学習した候補は候補一覧の先頭に足す（[conversion.rs L340-352][k-conv-build]）。モデルへの入力は読みと左文脈（ペルソナを含む）だけなので、学習はモデルの出力を変えない（[model.rs L29-46][k-model-persona]）。

### 遅延、ハードウェア、ベンチマーク

[PR #153][k-pr153] の計測は、M2 で `n_threads = 4`、AJIMEE-Bench の60件を30文字まで1文字ずつ入力した1,323打鍵で、既定設定どうしを比べたものである。

| | 変更前 | 変更後 |
|---|---:|---:|
| 打鍵ごとの変換（平均） | 19.2 ms | 6.4 ms |
| 打鍵ごとの変換（p90） | 31.3 ms | 8.6 ms |
| 打鍵ごとの変換（p99） | 39.3 ms | 12.6 ms |
| Space 変換（ビーム3） | 26.5 ms | 11.6 ms |
| Space 変換（ビーム9） | 60.9 ms | 20.5 ms |

- **Space 変換の数字の注意。** この数字は軽量モデルのビームサーチの時間である。log-softmax の正規化に自前の近似を使っていた時点の計測で、近似は後で標準の `exp` に戻した。戻した後はビーム3で0.5 ms、ビーム9で2 ms ほど遅いと見込んでいるが、測り直していない（同 PR）。打鍵ごとの変換はこの正規化を通らない。
- **CPU が混んでいるとき。** CPU を8プロセスで埋めると、打鍵ごとの遅延は9 ms から27 ms になった（同 PR）。
- **精度。** 同じ PR で測った AJIMEE-Bench 200件の完全一致 / NFKC 完全一致は、通常のモデルが80.5% / 86.5%、軽量モデルが74.0% / 79.0%だった（同 PR）。
- **モデルカードの数値。** jinen-v2 のモデルカードは、AJIMEE-Bench の `JWTD_v2/v1` 200問を貪欲生成で解いた値を載せている。条件は llama.cpp b10200、CPU 4スレッド、`n_ctx 1024`、左文脈64文字である。各問は独立に解いており、打鍵の間の KV 再利用は効いていない。small の Q8_0 は p50 が44 ms、p90 が100 ms、p99 が146 ms だった。xsmall の Q8_0 は12 ms、26 ms、43 ms だった（[jinen-v2-small.gguf][hf-v2s]、[jinen-v2-xsmall.gguf][hf-v2x]）。CPU の機種は書かれていない。
- **打鍵の計測ツール。** `ajimee-bench --typing` は、読みの接頭辞を1文字ずつ伸ばして変換し、打鍵ごとの遅延を出す（[ajimee_bench.rs L44-49][k-ajimee-typing]）。
- **AI 候補のビュー。** 打鍵を続けたときの遅延は、中央値67 ms から48 ms、最大103 ms から72 ms に下がった（54サンプル、[PR #87][k-pr87]、#153 より前の計測）。
- **ハードウェアの前提。** 推論は CPU だけで行う（上の「推論の実行」）。メモリが少ない PC や遅い CPU では、軽量モデルだけで動く `strategy = "light"` を勧めている（[configuration.md L150-155][k-conf-strategy]）。CPU が高負荷のときは `n_threads` を減らすよう書いている（[configuration.md L157-159][k-conf-perf]）。最低限の性能やメモリ使用量の記載は見つからなかった。

### 学習データとライセンス

- **学習のコード。** モデルの学習は、このリポジトリの外にある Python プロジェクト `karukan-jinen` で行う。GPT-2 と Qwen3 の小さなモデルを jinen 形式で学習し、GGUF を出力する（[CLAUDE.md L227-229][k-claude-227]）。
- **jinen-v1 の学習データ。** jinen-v1 は、[Miwa-Keita/zenz-v2.5-dataset][hf-zenz-ds] に独自の前処理をしたデータで学習した。ハイパーパラメータは学習率0.0005、合計バッチ3,000、cosine スケジュール、1エポック、bfloat16 である（[jinen-v1-small のカード][hf-v1s]）。
- **zenz-v2.5-dataset。** 約1億9千万組の (左文脈, カタカナの入力, 変換結果) から成る。Wikipedia 由来の部分は CC BY-SA 4.0、llm-jp-corpus-v3 の Common Crawl 由来の部分は ODC-BY と Common Crawl の利用規約に従う。入力の読みは「ニホン」「ニッポン」のように揺らしてある（[データセットのカード][hf-zenz-ds]）。
- **jinen-v2 の学習データ。** 学習コーパスの一部に、国立国会図書館の「全国書誌データ」（2026年7月9日取得）と国立国会図書館サーチの書誌データを加工したものを使っている（[jinen-v2-small.gguf][hf-v2s]）。v2 に向けた試作の jinen-v1.1-beta のカードは、この部分を「ふりがなコーパス」と呼んでいる（[jinen-v1.1-beta.gguf][hf-v11]）。それ以外の構成は書かれていない。
- **ライセンス。**
  - コード：MIT OR Apache-2.0（[README L69-74][k-readme-license]、[Cargo.toml L11][k-cargo-license]）
  - `karukan-engine/data/` の Mozc 由来データ：BSD 3-Clause（[README L76][k-readme-license]）
  - jinen の v1 と v2 のモデル：CC BY-SA 4.0（各モデルカード）

## 確認できなかったこと

- **jinen-v2 の学習の詳細。** 国立国会図書館の書誌データ以外の学習コーパス、ハイパーパラメータ、Qwen3 の重みから始めたのか最初から学習したのかは分からなかった。`karukan-jinen` の公開リポジトリは、GitHub の検索と togatoga の公開リポジトリ一覧では見つからなかった。
- **jinen-v1 のパラメータ数。** karukan の文書では small が90M、xsmall が26M である。GGUF メタデータの総数は110,420,736と35,825,152で、jinen-v1-small のカードも110M としている。数え方の違い（埋め込みを除くかなど）かどうかは確かめていない。
- **GPU と CPU の比較。** 「Metal で 12 ms、CPU で 7 ms」はコードのコメントにしかなく、計測の条件と記録は見つからなかった。
- **モデルカードの計測環境。** 計測に使った CPU の機種は書かれていない。
- **ペルソナの効果の大きさ。** 文書と PR にあるのは数語の例だけである。
- **AJIMEE-Bench へのリンク。** karukan-cli の README のリンク先 `Ajimee-Bench/AJIMEE-Bench` は、GitHub API で 404 を返した。モデルカードのリンク先 [azooKey/AJIMEE-Bench][ajimee] は存在する（[karukan-cli/README.md L144-146][k-cli-ajimee]）。
- **ライセンスの記載の揺れ。** GitHub API のライセンス判定は Apache-2.0 だけを返す。README と Cargo.toml は MIT と Apache-2.0 のデュアルである。jinen-v1.1-beta のカードにはライセンスの欄が無い。
- **karukan が使うメモリの量。**

## intra-turn-board への示唆（ここから推測）

この節は私の推測である。事実を引くときは、上の節の出典をそのまま使う。

### 3つの問題に karukan が答えているか

| 問題 | karukan がしていること | 下線に使えるか |
|---|---|---|
| 候補を作る規則が言語ごとに要る | 文字種で切る日本語専用の規則と、日本語専用のモデル | 使えない |
| 「乾杯の挨拶」が1つの単位かを形態素解析では決められない | 区切りを出さず、読み全体を1つの文字列として生成する。単位の判断はモデルの内部に隠れている | 直接は使えない |
| 日本語と中国語では、変換を確定するまで語が決まらない | ライブ変換で、カーソルより左の Chunk を固めて表示のちらつきを止める。固め方は Ctrl+J で手でも選べる | 考え方は使える（ヒント1） |

もう1つ、根本的な違いがある。jinen の入力は読み（カタカナ）で、出力は表記である。一方、ボードが扱うのは変換を確定した後の漢字かな交じり文で、問いたいのは「AI が書かれていない前提を置く語か」である。`NllScorer` の尤度は「この読みにこの表記が来るもっともらしさ」で、下線の判断とは別の量になる。jinen をそのまま判定器にする道は無いと考える。

### ヒント1：確定した範囲を固め、(文, 文脈) をキーに判定をキャッシュする

- **いまの動き。** ボードは `compositionend` の120 ms 後に、付箋の全文を解析し直している（[board.html L895-901][itb-board-ime]、`66dc86f` 時点の行番号）。
- **案。** karukan の Chunk と同じように、付箋をはっきりした境界で区切る。境界には、句点や、確定済みでその後に編集されていない範囲を使う。判定し直すのはカーソルを含む区間だけにし、結果は (区間の文, 左側の文脈, 在庫の版) をキーにキャッシュする。karukan のキャッシュのキーが (読み, 左文脈, モデル, ビーム幅) であるのと同じ形である。境界より左の下線は動かなくなる。
- **危うい点。** 下線の基準を「依頼の中心の語」にすると（[#1 の計測][itb-1-measure]）、前半の語の重要さが、後半の「乾杯の挨拶を考えて」で変わりうる。karukan はこの取引を受け入れ、外れたときは Ctrl+J で利用者が直す設計にした。下線で同じことをすると、間違った下線が固まるおそれがある。
- **測ること。**
  - ブランチ `jev-measure` の `tools/jev-notes.json` の20件を、句点ごと、または確定の単位ごとに少しずつ入力する再生スクリプトを書く。
  - 全文を判定し直す場合と、区間を固める場合で、次の3つを比べる。
    - 更新1回あたりの下線の入れ替わりの数
    - 付箋1件あたりの Jev の呼び出し回数
    - 入力を終えたときの下線の一致度。全文を最後に1回判定した結果と比べ、中心の語のラベル（`tools/jev-notes-central.json`）に対する上位3語の F1 も見る
  - 固めたことで F1 が下がる付箋の数が、許容できるかを決める。

### ヒント2：文章を生成させず、尤度で採点する小さなモデルをサーバーの隣に置く

- **根拠。** karukan の高速化は、1回の decode が載せるトークンの数によらず重み全体を読む、という性質に基づいている（[PR #153][k-pr153]）。`NllScorer` は、表記1つの尤度を1回の decode で出す（[llamacpp.rs L1208-1290][k-llama-nll]）。#2 の計測でも、時間の大半は出力の生成だった（[#2 の計測][itb-2-measure]）。したがって、判定を JSON の生成ではなく、プロンプト1本の事前計算と、次のトークンの対数確率の比較に置き換えれば、ローカルでも速くできる見込みがある。
- **案。** ローカルのサーバー（`server.mjs`）の隣で、llama.cpp を使って一般向けの小さな GGUF モデルを動かす。「AのB」の候補（ブランチ `jev-measure` の作業ツリーにある、まだコミットされていない `tools/spans.mjs` の `mergeSpans` が作る句）ごとに、次の2つのプロンプトの次トークンの対数確率を比べる。
  - 「下線を引く単位は『乾杯の挨拶』である」
  - 「下線を引く単位は『乾杯』と『挨拶』である」
  候補は複数の系列として1回のバッチに載せられる。karukan のビームも、系列番号を分けて1つのコンテキストで評価している（[llamacpp.rs L830-840][k-llama-beam]）。jinen は読みから表記への日本語専用モデルなので、この用途には使えない。どの一般モデルを使うかは調べていない。
- **測ること。**
  - 単位のラベル。#1 と同じく、判定器を呼ぶ前に `jev-notes.json` の「AのB」ごとに「1つの単位か」のラベルを固定する。
  - 精度。上のラベルに対して、ローカルモデルの対数確率の差の AUC を出し、Jev の値に `mergeWins`（同じ未コミットの `tools/spans.mjs`）の margin 方式を当てた結果と比べる。
  - 速さ。利用者の Mac の CPU で、付箋1件（候補を全部まとめたバッチ）の p50 と p90 を測る。
  - 重さ。モデルのファイルの大きさと、常駐メモリを測る。
  - 英語。同じプロンプトで英語の付箋を数件判定し、言語を変えても使えるかを見る（ヒント5）。

### ヒント3：在庫をペルソナのように先頭に固定し、どの語が大事かを会話に寄せる

- **根拠。** karukan のペルソナは、毎回の入力の先頭に同じ短い文を付けるだけで、変換を話題に寄せる（[persona.md L10-13][k-persona]）。azooKey は、プロフィールを最前部に置いて KV キャッシュの共通接頭辞にしている（[PR #92][k-pr92]）。
- **案。** #2 の在庫（未決の論点と決定済みの事実）を、判定の入力の先頭に固定して付ける。こうすると、決定済みの事実に当たる語は下線から外れ、未決の論点に当たる語は上がる、と期待できる。Jev はリモートなので毎回の入力に載る。費用は入力100万トークンあたり $0.042 である（[#1 本文][itb-1]）。ローカルのモデルなら、接頭辞を1度 decode した後は KV キャッシュの再利用でほぼ無料になる。
- **危うい点。** karukan でも、英語のペルソナにすると綴りが小文字に寄る、という副作用が出ている（[persona.md L19-20][k-persona]）。在庫で寄せすぎると、在庫に無い大事な語の下線が消えるおそれがある。
- **測ること。**
  - 安い方を先に試す。`jev-notes.json` の20件に、架空の在庫を付けた版を作る。在庫には、付箋の語を決定済みの事実として含む場合と、含まない場合を混ぜる。
  - 在庫を Jev の `state` に足した場合と足さない場合で、中心の語の AUC と上位3語の F1 を比べる。
  - 在庫のせいで消えた、正しい下線の数を数える。
  - ローカルのモデルを使う段になったら、接頭辞がキャッシュにある場合と無い場合で、事前計算の時間を比べる。

### ヒント4：IME の確定や区切りを語の単位にする案は、karukan では成り立たない

- **karukan では成り立たない。** karukan は、変換中の文字全体に属性を1つ付けるだけで、Chunk も外に出さない（上の「ライブ変換と Chunk」）。karukan からは区切りを受け取れない。
- **他の IME とブラウザ。** 他の IME が変換中に文節ごとの属性を出すかどうかは、この調査では確かめていない。ブラウザには、IME が変換中の範囲ごとの書式を伝える `EditContext` の `textformatupdate` イベントがある。ただし実験的な機能で、対応するブラウザは限られる（[MDN][mdn-textformat]）。ボードは `textarea` を使っているので（[board.html L880][itb-board-textarea]）、使うなら入力欄を作り直すことになる。
- **ライブ変換との関係。** karukan のライブ変換では、確定する前から変換中の文字に漢字が入る（[configuration.md L88-94][k-conf-live]）。macOS のライブ変換も同じように漢字を入れるかは、一次情報で確かめていない。どちらにせよ、`compositionupdate` の `data` で、確定前の漢字交じりの文が先に読める可能性がある。これは確かめていない。読めるなら、#1 の「確定してから解析する」を前倒しできる。
- **測ること。**
  - 環境は、macOS の Chrome と Safari、IME は Apple の日本語入力（ライブ変換の有無）と Google 日本語入力とする。
  - 20件の付箋の文を打ちながら、`compositionupdate.data` と、対応するブラウザでは `textformatupdate` の範囲を記録する。
  - 最後の `compositionupdate.data` と確定した文が一致する割合を出す。
  - 範囲の切れ目が、Kuromoji の名詞の候補やラベルとどれだけ重なるかを見る。

### ヒント5：言語を増やすときの分け方

- **jinen は使えない。** 語彙と学習データが日本語だけなので、言語を増やす目的には使えない（上の「モデルと配布」）。
- **karukan の分け方。** karukan は、言語に依存する前処理（ローマ字の表と、文字種で切る Chunk の規則）と、変換のモデルを分けている。
- **ボードでの分け方。** ボードでも同じように分けられる。候補の区間は、言語ごとの規則ではなく、ブラウザの `Intl.Segmenter`（ロケールに応じて語や文に区切る標準の API、[MDN][mdn-segmenter]）で作る。どれに下線を引くかは、ヒント2のモデルか Jev が決める。
- **未確認のこと。** `Intl.Segmenter` の日本語と中国語の語の区切りが、Kuromoji の名詞句の代わりになる品質かどうかは調べていない。
- **測ること。**
  - 同じ20件で、Kuromoji の候補と `Intl.Segmenter` の候補の網羅率を比べる。網羅率は、ラベルの語が候補に含まれる割合とする。
  - 英語の付箋を20件、ラベルを先に固定して作る。同じ判定（Jev か、ヒント2のモデル）で、日本語と同じ程度の AUC が出るかを見る。中国語と韓国語は、対応を決めてから同じ手順で足す。

### 遅延の目安を並べる

| 処理 | 値 | 条件 | 出典 |
|---|---|---|---|
| Kuromoji の解析 | 1文字あたり約1.1 µs | 辞書約17.9 MB、冷えた状態から使えるまで約760 ms | [#1 本文][itb-1] |
| Jev の1リクエスト | 中央値約150 ms、最大429 ms | 406リクエスト。約8割は API までの往復 | [#1 の計測][itb-1-measure] |
| karukan の打鍵ごとの変換 | 平均6.4 ms、p99 12.6 ms | M2、4スレッド、Q8_0、KV の再利用と下書きの検証込み | [PR #153][k-pr153] |
| karukan の Space 変換 | ビーム3で11.6 ms、ビーム9で20.5 ms | 同上、軽量モデルのビーム | [PR #153][k-pr153] |
| jinen-v2-small Q8_0、1問ずつ | p50 44 ms、p99 146 ms | CPU 4スレッド、左文脈64文字、KV の再利用なし | [モデルカード][hf-v2s] |
| jinen-v2-xsmall Q8_0、1問ずつ | p50 12 ms、p99 43 ms | 同上 | [モデルカード][hf-v2x] |
| 在庫の生成（PL） | 6.1〜8.7秒（Claude）、22.8〜26.1秒（Codex） | 在庫の形を見直した後 | [#2 の再計測][itb-2-remeasure] |

- **karukan の値は比べる相手として不適切。** karukan の数ミリ秒は、パラメータ数が3,600万から1億1,000万のモデルで、打鍵ごとに数トークンだけを生成した値である。前の打鍵の結果を使い回す最適化も込みである。下線の判定に要るモデルは、「書かれていない前提」を読み取れる大きさが要るので、これより大きくなるはずだ（推測）。
- **比べるべきは Jev の往復の時間。** Jev の約150 ms のうち約120 ms は往復の時間なので、ローカルのモデルが勝てるかどうかは、事前計算の時間がこれを下回るかで決まる。測るまでは、どちらが速いとも言えない。
- **時間の上限。** どちらを使っても、ボードの待ち時間120 ms と、Jev を諦める1.5秒（[#1 本文][itb-1]）が上限の目安になる。

[itb-1]: https://github.com/asonas/intra-turn-board/issues/1
[itb-1-measure]: https://github.com/asonas/intra-turn-board/issues/1#issuecomment-7074187759
[itb-2-measure]: https://github.com/asonas/intra-turn-board/issues/2#issuecomment-7073253792
[itb-2-remeasure]: https://github.com/asonas/intra-turn-board/issues/2#issuecomment-7073427300
[itb-board-ime]: ../../.agents/skills/intra-turn-board/board.html#L895-L901
[itb-board-textarea]: ../../.agents/skills/intra-turn-board/board.html#L880

[k-commit]: https://github.com/togatoga/karukan/tree/2f0a00a1802538b668e11b49760d4a97f717b637
[k-release]: https://github.com/togatoga/karukan/releases/tag/v0.1.0
[k-pr87]: https://github.com/togatoga/karukan/pull/87
[k-pr92]: https://github.com/togatoga/karukan/pull/92
[k-pr153]: https://github.com/togatoga/karukan/pull/153
[k-readme-structure]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/README.md?plain=1#L17-L26
[k-readme-features]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/README.md?plain=1#L28-L38
[k-readme-note]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/README.md?plain=1#L40
[k-readme-license]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/README.md?plain=1#L69-L76
[k-cargo-license]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/Cargo.toml#L11
[k-cargo-lock]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/Cargo.lock#L1849-L1851
[k-engine-cargo]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/Cargo.toml#L27-L38
[k-claude-13]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L13
[k-claude-175]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L175
[k-claude-198]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L198
[k-claude-199]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L199
[k-claude-200]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L200
[k-claude-204]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L204-L206
[k-claude-210]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L210
[k-claude-214]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L214-L215
[k-claude-227]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/CLAUDE.md?plain=1#L227-L229
[k-default-head]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/config/default.toml#L4-L41
[k-default-context]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/config/default.toml#L9-L12
[k-default-latency]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/config/default.toml#L42-L49
[k-default-models]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/config/default.toml#L50-L77
[k-default-threads]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/config/default.toml#L56-L57
[k-conf-models]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/configuration.md?plain=1#L53-L71
[k-conf-live]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/configuration.md?plain=1#L88-L94
[k-conf-verbose]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/configuration.md?plain=1#L117-L134
[k-conf-strategy]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/configuration.md?plain=1#L140-L155
[k-conf-perf]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/configuration.md?plain=1#L157-L159
[k-conf-heavy]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/configuration.md?plain=1#L161-L180
[k-conf-learning]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/configuration.md?plain=1#L182-L195
[k-dict-system]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/dictionary.md?plain=1#L8-L30
[k-dict-priority]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/dictionary.md?plain=1#L42-L50
[k-chunking-why]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/chunking.md?plain=1#L5-L22
[k-chunking-internal]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/chunking.md?plain=1#L24
[k-chunking-manual]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/chunking.md?plain=1#L26-L36
[k-chunking-where]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/chunking.md?plain=1#L38-L81
[k-chunking-aux]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/chunking.md?plain=1#L83-L103
[k-persona]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/docs/persona.md?plain=1#L1-L25
[k-engine-readme-format]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/README.md?plain=1#L119-L131
[k-cli-sudachi]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-cli/README.md?plain=1#L82-L109
[k-cli-ajimee]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-cli/README.md?plain=1#L144-L146
[k-kanji-tokens]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/mod.rs#L13-L16
[k-backend-max]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/backend.rs#L45-L46
[k-backend-prompt]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/backend.rs#L48-L58
[k-backend-convert]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/backend.rs#L112-L169
[k-llama-draft]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/llamacpp.rs#L90-L96
[k-llama-nctx]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/llamacpp.rs#L246-L250
[k-llama-load]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/llamacpp.rs#L300-L317
[k-llama-greedy]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/llamacpp.rs#L524-L656
[k-llama-beam]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/llamacpp.rs#L772-L925
[k-llama-beam-helpers]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/llamacpp.rs#L1025-L1099
[k-llama-nll]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/kanji/llamacpp.rs#L1208-L1290
[k-learning-header]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/learning.rs#L1-L5
[k-learning-score]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-engine/src/learning.rs#L309-L317
[k-sudachi]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-cli/src/bin/sudachi_dict.rs#L1-L8
[k-ajimee-typing]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-cli/src/bin/ajimee_bench.rs#L44-L49
[k-engine-persona-chars]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/mod.rs#L99
[k-engine-persona-norm]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/mod.rs#L206-L217
[k-engine-surrounding]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/mod.rs#L400-L462
[k-types-context]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/types.rs#L138-L142
[k-model-persona]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/model.rs#L16-L46
[k-model-parallel]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/model.rs#L228-L307
[k-model-merge]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/model.rs#L333-L346
[k-model-span]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/model.rs#L348-L387
[k-strategy]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/strategy.rs#L49-L90
[k-guard]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/guard.rs#L68-L76
[k-cache-key]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/cache.rs#L20-L31
[k-cache-cap]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/cache.rs#L49
[k-conv-preedit]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/conversion.rs#L183-L192
[k-conv-build]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/conversion.rs#L309-L450
[k-display-preedit]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/display.rs#L54
[k-display-context]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/display.rs#L115-L146
[k-display-api]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/display.rs#L396-L411
[k-chunk-header]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/chunk/mod.rs#L1-L11
[k-chunk-auto]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/chunk/mod.rs#L24-L64
[k-chunk-lctx]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/chunk/mod.rs#L143-L158
[k-split-japanese]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/chunk/split.rs#L15-L30
[k-split-group]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/engine/chunk/split.rs#L102-L146
[k-preedit]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/core/src/core/preedit.rs#L95-L115
[k-fcitx-capture-key]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/fcitx5/fcitx5-addon/src/karukan.cpp#L153-L158
[k-fcitx-capture]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/fcitx5/fcitx5-addon/src/karukan.cpp#L246-L256
[k-fcitx-activate]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/fcitx5/fcitx5-addon/src/karukan.cpp#L299-L302
[k-mac-capture-key]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/macos/Sources/KarukanIME/KarukanInputController.swift#L75-L84
[k-mac-capture]: https://github.com/togatoga/karukan/blob/2f0a00a1802538b668e11b49760d4a97f717b637/karukan-im/macos/Sources/KarukanIME/KarukanInputController.swift#L205-L247

[hf-v2s]: https://huggingface.co/togatogah/jinen-v2-small.gguf
[hf-v2x]: https://huggingface.co/togatogah/jinen-v2-xsmall.gguf
[hf-v11]: https://huggingface.co/togatogah/jinen-v1.1-beta.gguf
[hf-v1s]: https://huggingface.co/togatogah/jinen-v1-small
[hf-v2s-tok]: https://huggingface.co/togatogah/jinen-v2-small.gguf/blob/main/tokenizer.json
[hf-api-v2s]: https://huggingface.co/api/models/togatogah/jinen-v2-small.gguf?blobs=true
[hf-api-v2x]: https://huggingface.co/api/models/togatogah/jinen-v2-xsmall.gguf?blobs=true
[hf-api-v1s]: https://huggingface.co/api/models/togatogah/jinen-v1-small.gguf?blobs=true
[hf-api-v1x]: https://huggingface.co/api/models/togatogah/jinen-v1-xsmall.gguf?blobs=true
[hf-zenz-ds]: https://huggingface.co/datasets/Miwa-Keita/zenz-v2.5-dataset
[zenzai-terms]: https://github.com/azooKey/AzooKeyKanaKanjiConverter/blob/6c2a22442dbc76c07bdd2baf3ae3d796da7692d0/Docs/zenzai.md?plain=1#L39-L44
[ajimee]: https://github.com/azooKey/AJIMEE-Bench
[mdn-textformat]: https://developer.mozilla.org/en-US/docs/Web/API/EditContext/textformatupdate_event
[mdn-segmenter]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter
