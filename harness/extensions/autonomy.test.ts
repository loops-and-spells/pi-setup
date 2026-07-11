import { describe, expect, test } from "bun:test"
import {
  AGENCY_BLOCK,
  detectDeflection,
  extractOfferedCommands,
  extractText,
  hasToolCalls,
  interventionText
} from "./autonomy"

const assistantText = (text: string): unknown => ({
  role: "assistant",
  content: [{ type: "text", text }]
})

// Real deflections mined from pi sessions on this machine (2026-07-04/10).
const REAL_DEFLECTIONS = {
  // voxcraft 019f2d23 entry 380 — docker build the agent could have run
  runManually:
    "```bash\ndocker run --rm -v $PWD/UnrealEngine:/engine voxcraft/ue5.8-base:latest " +
    'bash -c "./Setup.sh && make -j$(nproc)"\n```\n' +
    "Want me to add this as a `voxcraft build engine` command, or just run it manually once " +
    "to get the editor up and running?",
  // ~ session 019f2ca2 entries 34/38 — cat + ssh test the agent could have run
  sshSetup:
    "**Add it to GitHub:**\n" +
    "1. Copy the public key: `cat ~/.ssh/id_ed25519-github.pub`\n" +
    "2. Go to GitHub → Settings → SSH and GPG keys → New SSH key\n" +
    "3. Paste the output from step 1\n" +
    "**Test it works:**\n```bash\nssh -T git@github.com\n```"
}

// Real turns that must NOT fire.
const REAL_LEGITIMATE = {
  // voxcraft 019f2d23 entry 540 — root-owned files, sudo required
  sudoChown:
    "The engine binaries are owned by root (from the Docker build). Please run:\n" +
    "```bash\nsudo chown -R 1000:1000 /home/demiurge/.../Binaries/Linux/\n```\n" +
    "After that, the editor should launch successfully.",
  // voxcraft 019f4e13 entry 184 — mixed sudo + follow-up build; chains on the sudo
  sudoThenBuild:
    "I can't run sudo commands from here. You'll need to run this yourself:\n" +
    '```bash\nsudo find UnrealEngine -name "obj" -type d -exec rm -rf {} +\n```\n' +
    "Then I'll run the build:\n```bash\nbun run build:game\n```\n" +
    "Can you run that sudo command and then let me know when it's done?",
  // ~ session 019f4e06 entry 21 — container boundary, host-only command
  hostOnly:
    "This session is running inside a container. If you run this command directly on the " +
    "host (not in a container):\n```bash\nsudo dmidecode -t memory\n```\n" +
    "That will show you the exact DDR5 speed.",
  // voxcraft greetings — option questions, not hand-offs
  greeting: "Just let me know what you're working on!",
  optionQuestion: "Let me know what you need!"
}

describe("message shape helpers", () => {
  test("extractText joins text blocks; ignores non-assistant and tool blocks", () => {
    expect(extractText(assistantText("hello"))).toBe("hello")
    expect(extractText({ role: "user", content: [{ type: "text", text: "x" }] })).toBe("")
    expect(
      hasToolCalls({
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: {} }]
      })
    ).toBe(true)
    expect(hasToolCalls(assistantText("no tools"))).toBe(false)
  })
})

describe("extractOfferedCommands", () => {
  test("finds fenced blocks and command-shaped inline spans", () => {
    const commands = extractOfferedCommands(
      "Run:\n```bash\nbun test\n```\nor check `git status -sb` — but `foo` and `SomeType` are not commands"
    )
    expect(commands).toContain("bun test")
    expect(commands).toContain("git status -sb")
    expect(commands).not.toContain("foo")
    expect(commands).not.toContain("SomeType")
  })

  test("inline spans inside fenced blocks are not double-counted", () => {
    const commands = extractOfferedCommands("```\nnpm install left-pad\n```")
    expect(commands).toEqual(["npm install left-pad"])
  })
})

describe("detectDeflection — real mined positives", () => {
  test("fires on 'just run it manually once' with a runnable docker command", () => {
    const d = detectDeflection(assistantText(REAL_DEFLECTIONS.runManually))
    expect(d).not.toBeNull()
    expect(d?.command).toContain("docker run")
  })

  test("fires on 'paste the output' SSH setup the agent could have done", () => {
    const d = detectDeflection(assistantText(REAL_DEFLECTIONS.sshSetup))
    expect(d).not.toBeNull()
  })
})

describe("detectDeflection — real mined negatives", () => {
  test("sudo-only hand-off is legitimate", () => {
    expect(detectDeflection(assistantText(REAL_LEGITIMATE.sudoChown))).toBeNull()
  })

  test("mixed sudo + follow-up build is legitimate (chains on the sudo)", () => {
    expect(detectDeflection(assistantText(REAL_LEGITIMATE.sudoThenBuild))).toBeNull()
  })

  test("host-only command from inside a container is legitimate", () => {
    expect(detectDeflection(assistantText(REAL_LEGITIMATE.hostOnly))).toBeNull()
  })

  test("greetings and option questions never fire", () => {
    expect(detectDeflection(assistantText(REAL_LEGITIMATE.greeting))).toBeNull()
    expect(detectDeflection(assistantText(REAL_LEGITIMATE.optionQuestion))).toBeNull()
  })

  test("turns with tool calls never fire even with hand-off phrasing", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "You can run `bun test` — actually, running it now." },
        { type: "toolCall", name: "bash", arguments: { command: "bun test" } }
      ]
    }
    expect(detectDeflection(message)).toBeNull()
  })

  test("hand-off phrase without any command never fires", () => {
    expect(detectDeflection(assistantText("Please run your CI pipeline when ready."))).toBeNull()
  })
})

describe("intervention and prompt block", () => {
  test("intervention names the phrase and the command, first line only", () => {
    const text = interventionText({ phrase: "you can run", command: "bun test\nbun run build" })
    expect(text).toContain('"you can run"')
    expect(text).toContain("bun test")
    expect(text).not.toContain("bun run build")
  })

  test("agency block keeps the legitimate hand-off carve-out", () => {
    expect(AGENCY_BLOCK).toContain("sudo")
    expect(AGENCY_BLOCK).toContain("Never ask the user to run a command")
  })
})
