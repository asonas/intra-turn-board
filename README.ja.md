# Intra-turn Board

[English](README.md)

Intra-turn Board は、Claude Code と Codex で使えるエージェントのスキルです。ブラウザにローカルのホワイトボードを開き、付箋に書いた依頼を AI と一緒に練ります。どちらかの番が終わるのを待たずに、次の2つのやり取りができます。

- **付箋を書いている途中**：AI が勝手に決めてしまいそうな語に下線が付きます。下線を押すと、送る前にその語の意味を選べます。
- **AI が返事を書いている途中**：あなたが決めるべきところで AI が止まり、そこを空欄として残します。空欄を埋めると続きが書かれ、あとで選び直すとそこから書き直されます。

ボードは起動したセッションの中で動くので、返事にはそれまでエージェントと話した内容が反映されます。

## 必要なもの

- macOS と Node.js 22 以降（Linux でも動くように作っていますが、試していません）
- サインイン済みの [Claude Code](https://code.claude.com/) か [Codex CLI](https://github.com/openai/codex)
- Jev の API キー（TypeSafe、[ドキュメント](https://docs.typesafe.ai/)）。下線を引く語の判定に使います
- [envchain](https://github.com/sorah/envchain)（推奨）。API キーをキーチェーンに保管します

TypeSafe の API キーが無くてもボードは動きます。ただし下線は簡単な規則で選ぶことになり、精度がはっきり落ちます。

## インストール

リポジトリを clone し、使うエージェントのスキルのフォルダにリンクを張ります。

```sh
git clone https://github.com/asonas/intra-turn-board.git
cd intra-turn-board

# Claude Code
ln -s "$PWD/.agents/skills/intra-turn-board" ~/.claude/skills/intra-turn-board

# Codex
ln -s "$PWD/.agents/skills/intra-turn-board" ~/.codex/skills/intra-turn-board
```

コピーではなくリンクにしておくと、`git pull` するだけでスキルが新しくなります。

## TypeSafe の API キーを保管する

envchain の利用を勧めます。キーはキーチェーンに置かれ、ボードのサーバーにだけ渡ります。シェルやエージェントのセッションの環境変数には入りません。

```sh
envchain --set typesafe TYPESAFE_API_KEY
```

値の入力を求められるので、API キーを貼り付けます。キーは `typesafe` という名前空間に保管されます。

## 使い方

プロジェクトでセッションを始め、いつもどおりエージェントと会話します。一緒に考えたいことが出てきたら、スキルを呼びます。

- Claude Code：`/intra-turn-board` と入力する
- Codex：`intra-turn-board` スキルを使うよう頼む

Jev を使うには、サーバーを envchain 経由で起動するようエージェントに伝えます（例：「`envchain typesafe` 付きでボードを起動して」）。ボードは既定のブラウザで開きます。

ボードでは、次の順に進めます。

1. 何もないところをクリックして付箋を置き、依頼を書く。
2. 下線の付いた語は、AI が前提を置こうとしている語です。押すと、候補から選ぶか自分の言葉で答えられます。
3. 送るボタンを押す。返事は付箋の隣に、線でつながって現れます。
4. 返事の空欄を埋める。すべて埋めると、AI が続きを書きます。
5. 返事の一節を選択すると、その部分について追加で質問できます。

背景をドラッグすると画面が動きます。終わったら、ボードを止めるようエージェントに頼んでください。ボードの内容は保存されず、ページを閉じるか再読み込みすると消えます。

## 何がどこに送られ、どれくらいかかるか

- **返事**は、いま使っているエージェントのセッションを fork して書きます（`claude -p --resume … --fork-session` か `codex exec fork`）。Claude のプランでサインインした Claude Code では、ほかの `claude -p` と同じくプランの使用量の上限から消費されます。1回の返事にはおよそ10秒かかります。
- **起動したとき**、サーバーはセッションの記録からあなたとアシスタントの発言だけを取り出し、軽いモデル（Claude Code では Sonnet、Codex では gpt-6.2-sol）に未決の論点と決まったことを書き出させます。ボードはこの一覧を使って、会話に合った問いを出します。およそ10秒かかりますが、その間もボードは使えます。
- **下線の判定**では、付箋の文と候補の語を TypeSafe の API に送ります。1回およそ150ミリ秒で、費用は1セント未満です。
- **候補の語を拾う日本語の辞書**（Kuromoji、約18MB）は、ページを開いたときに jsDelivr から読み込みます。

サーバーは `127.0.0.1` だけで待ち受け、URL に含まれるランダムなトークンが無いと応答しません。モデルを呼ぶたびに、遅延とトークン数がサーバーの出力に記録されます。

## 開発の状況

試作の段階です。下線の判定は日本語の付箋に合わせて調整しています。計画と計測の記録は [GitHub Issues](https://github.com/asonas/intra-turn-board/issues) にあります。

## 背景

ボードのやり取りは、人と AI のターン制を超えるやり取りについての Bruce Liu の研究（[博士論文](https://escholarship.org/uc/item/28d8b7wd)）に基づいています。入力中に AI の前提を示すこと（feedforward）と、AI の返事に空欄を残してユーザーに埋めてもらうことの2つです。
