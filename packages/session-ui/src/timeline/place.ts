import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { timelineNoticeRequired, type TimelineDetail, type TimelinePlacement } from "./detail"
import { factsOf, scriptFilePartID, scriptFiles, type Fact, type FileFact } from "./facts"

/**
 * Where each fact shows, under the Timeline detail setting: its category, whether it stands alone, joins a group or
 * hides, and whether it starts open. The two timelines place a few things differently; `timeline` says which asks.
 */

type Content = SessionMessageAssistant["content"][number]

export type TimelineKind = "current" | "next"

/** The group a fact folds into, or `part` where it stands on its own row. */
export type PlaceGroup = "part" | "context" | "read" | "file" | "events" | "subagent"

export type Place = {
  category?: keyof TimelineDetail
  placement: TimelinePlacement
  group: PlaceGroup
  /** Whether it starts open, where the setting says; undefined leaves it to the row. */
  opens?: boolean
}

/** The detail setting that shows or hides a fact. */
export function categoryOf(fact: Fact): keyof TimelineDetail | undefined {
  if (fact.kind === "thought") return "thinking"

  if (fact.kind === "file") return "edit"

  if (fact.kind === "outcome") return "notices"

  if (fact.kind !== "call") return

  if (fact.name === "shell" || fact.name === "execute") return "shell"

  if (fact.mode === "edit") return "edit"

  if (fact.name === "subagent") return "subagents"

  return "tools"
}

/** Places each fact, by id. `commentary` holds the ids of text that reads as commentary between calls. */
export function place(
  facts: readonly Fact[],
  detail: TimelineDetail,
  options: { timeline: TimelineKind; commentary?: ReadonlySet<string> },
) {
  return new Map(
    facts.map((fact) => [fact.id, placeFact(fact, detail, options.timeline, !!options.commentary?.has(fact.id))]),
  )
}

/** Places a run of message parts, in order. */
export function placeItems(
  items: readonly { messageID: string; partID: string; content: Content; file?: FileFact }[],
  detail: TimelineDetail,
  timeline: TimelineKind,
  commentary: ReadonlySet<Content> = new Set(),
) {
  const facts = items.map(
    (item) =>
      item.file ??
      factsOf([
        item.content.type === "tool"
          ? { ...item.content, messageID: item.messageID }
          : { type: item.content.type, id: item.partID, messageID: item.messageID },
      ])[0]!,
  )

  const placed = place(facts, detail, {
    timeline,
    commentary: new Set(
      items.flatMap((item) => (commentary.has(item.content) ? [`${item.messageID}:${item.partID}`] : [])),
    ),
  })

  return facts.map((fact) => placed.get(fact.id)!)
}

/** The files a finished script changed, as items of their own right after it, where edits show. */
export function scriptFileItems(messageID: string, messageIndex: number, content: Content, detail?: TimelineDetail) {
  if (!detail || detail.edit.placement === "hidden" || content.type !== "tool" || content.name !== "execute") return []

  return scriptFiles(content, messageID).map((file) => ({
    messageID,
    messageIndex,
    partID: scriptFilePartID(content.id, file.path),
    content,
    file,
  }))
}

/** Places one message part. */
export function placeContent(content: Content, detail: TimelineDetail, timeline: TimelineKind, commentary = false) {
  const fact = factsOf([content.type === "tool" ? content : { type: content.type }])[0]!

  return placeFact(fact, detail, timeline, commentary)
}

function placeFact(fact: Fact, detail: TimelineDetail, timeline: TimelineKind, commentary: boolean): Place {
  const category = categoryOf(fact)

  if (fact.kind === "text")
    return {
      placement: commentary ? "grouped" : "separate",
      group: commentary ? "context" : "part",
      opens: timeline === "next" ? false : undefined,
    }

  if (fact.kind === "thought") {
    const placement = detail.thinking.placement
    const opens = timeline === "next" ? false : detail.thinking.details === "expanded"

    return { category, placement, group: placement === "grouped" ? "context" : "part", opens }
  }

  // A file a script changed shows as a direct edit's file does, under the Edits setting.
  if (fact.kind === "file") {
    const placement = detail.edit.placement

    return {
      category,
      placement,
      group: placement === "grouped" ? "context" : "file",
      opens: detail.edit.details === "expanded",
    }
  }

  if (fact.kind !== "call" || !category) return { category, placement: "hidden", group: "part" }

  const setting = detail[category].placement
  const settled = fact.status !== "streaming" && fact.status !== "running"

  if (timeline === "current") {
    // The current timeline reads a call's own name, so v1 commands and patches keep their old rows.
    const failed = fact.status === "error" || (fact.failed && fact.tool !== "bash")
    const shows = failed || (fact.tool !== "todowrite" && (fact.tool === "question" ? settled : setting !== "hidden"))

    const group: PlaceGroup =
      fact.tool === "question" && !failed
        ? "part"
        : setting === "grouped"
          ? "context"
          : fact.groupedRead
            ? "read"
            : failed
              ? "part"
              : ["patch", "edit", "write"].includes(fact.tool)
                ? "file"
                : "part"

    const opens =
      fact.tool === "execute" || (setting === "hidden" && failed)
        ? true
        : category === "shell" || category === "edit"
          ? detail[category].details === "expanded"
          : fact.status === "error"
            ? false
            : undefined

    return { category, placement: shows ? (group === "context" ? "grouped" : "separate") : "hidden", group, opens }
  }

  // A call stopped before the model finished writing it did nothing.
  const shows =
    fact.name !== "todowrite" &&
    !(fact.stopped && !fact.called) &&
    (fact.name === "question" ? settled : setting !== "hidden")

  const group: PlaceGroup =
    category === "subagents"
      ? "subagent"
      : fact.background
        ? setting === "grouped" && !fact.failed
          ? "context"
          : "events"
        : fact.name === "question" && !fact.failed
          ? "part"
          : setting === "grouped"
            ? "context"
            : fact.groupedRead
              ? "read"
              : fact.failed
                ? "part"
                : fact.mode === "edit"
                  ? "file"
                  : "part"

  // A file shows its name and changes, closed; a stopped call shows as one that ran, so it opens as one would.
  const opens =
    fact.mode === "edit" && (fact.status !== "error" || fact.stopped)
      ? false
      : category === "shell" || category === "edit"
        ? detail[category].details === "expanded"
        : false

  return { category, placement: shows ? (group === "context" ? "grouped" : "separate") : "hidden", group, opens }
}

/** Whether a file's diff starts open, where edits show in detail. */
export function diffOpens(detail: TimelineDetail) {
  return detail.edit.details === "expanded"
}

/** Whether the setting hides all of the agent's activity, as Messages only does. */
export function hidesActivity(detail: TimelineDetail) {
  return (["shell", "edit", "thinking", "subagents", "tools"] as const).every(
    (category) => detail[category].placement === "hidden",
  )
}

/**
 * Where a notice shows. What background work reports stands on its own, so it shows where it finished. Where its
 * setting hides it, a notice that needs attention still shows. In the New timeline, a shell's report follows the shell
 * setting, and what changed the session always stands on its own.
 */
export function placeNotice(
  message: SessionMessageInfo,
  detail: TimelineDetail,
  timeline: TimelineKind,
  sessionEvent = false,
): TimelinePlacement {
  if (sessionEvent) return "separate"
  const source = message.type === "synthetic" ? message.metadata?.source : undefined

  const placement =
    source === "subagent"
      ? detail.subagents.placement
      : source === "shell" && timeline === "next"
        ? detail.shell.placement
        : detail.notices.placement

  if (placement === "hidden") return timelineNoticeRequired(message) ? "separate" : "hidden"

  return source === "subagent" || source === "shell" ? "separate" : placement
}
