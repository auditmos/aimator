# AGENTS.md

## Project Overview

CLI that walks a solo creator through producing a short animated episode: idea → project
and episode preparation → screenplay → character → shot list → prompt package → reference
images → opening frame → clips → final cut. ESM-only modules with strict TypeScript,
Biome for linting/formatting, Vitest for testing, semantic-release for releases.

Generated artifacts live **outside the repo**, under `AIMATOR_WORKSPACE`, grouped per
project and per image model. The stage contract (directory layout, the `*.stage.json`
shape and the cross-cutting invariants) is in [docs/pipeline.md](docs/pipeline.md).
Read it before touching anything that writes an artifact.

The prose around the code is three documents with three different readers, and a change
usually lands in exactly one of them. [docs/pipeline.md](docs/pipeline.md) is the contract:
what a stage consumes, produces and refuses. [docs/stages/](docs/stages/) is one page per
implemented stage for the person running the tool: the commands, their flags and what each
gate waits for. [README.md](README.md) is the front page that links to them, holding
only the input-and-output table. **A change to a command, a flag or a gate belongs in that
stage's page** as much as it belongs in the usage text; `src/test/docs.test.ts` fails the
build when a documented command or flag is missing from `--help`, when a local link points
at nothing, and when an implemented stage has no page, so this is enforced rather than
remembered. It cannot check prose, so a renamed concept is still yours to carry across.

Stages 0 through 10 are implemented. Stage 11 is a declared contract, not working code.
Stage 1 is the first that spends money, and it refuses to call the API until stage 0 is
approved for that project and episode. Stage 2 is the first image stage and the first to
branch into two model tracks; it does not depend on stage 1 and may run alongside it.
Stage 3 is the first artifact both image tracks share, so it has no track directory level;
it refuses to spend until the screenplay is approved, and does not depend on stage 2.
Stage 4 is the first to join the text side to the image side: it is shared by both tracks
and names none of them, and it refuses to spend until the shot list is approved **and**
every character that list puts on screen has an accepted `hero.png` on both tracks.
Stage 5 is the first where the two tracks really part company (one package, two
independent sets of images, two separate reviews), and the first whose gate sits inside its
own results: R04 waits for an accepted R03 *on that track*. It is therefore also the first
where one command can buy several images, so it states how many before it sends any.
Stage 6 is the first frame of the film and the first whose gate reads *another* stage's
per-track results: it waits for the references its manifest entry names, accepted on that
track. It is also the first stage with exactly one artifact, which is why `--artifact` is
required nowhere in it, not on `--regenerate`, not on `approve`. Stage 5 needs that flag
because it has six candidates and accepting the wrong one buys an image; a flag with one
legal value is ceremony standing where a decision used to be.
Stage 7 is the first that buys **two media** (an entry frame is an image, a clip is a
video) and the first whose gate is a **chain**: a continuing clip's entry frame waits for
the accepted end of the clip before it, that clip waits for its own entry frame, and every
link is a human saying yes. It is also where an asynchronous job first appears, so the
provider's task id lands on disk before the first poll and an interrupted attempt is
finished by asking rather than by paying again.
Stage 8 is the first that **buys nothing** and the first whose bytes come from a local
engine, which is why `producer.kind` grew a third value; its input the contract called
`edit-plan.json` turned out to be the approved shot list already, so it is derived rather
than stored; and its result is the picture cut, silent by declaration and loudly so,
because a soundtrack has to be written against the film that exists rather than the plan,
which makes it a row *below* this one rather than a half of it.
Stage 9 is the first that buys from **two providers** and the first whose artifacts live at
**two levels of the tree**: the words are shared like every text stage's and the mix is per
track like every video stage's. It writes none of the narration; stage 1 already did,
under a prompt that asks for speech in the film's language, and stage 3 carried it into
each shot's `Audio` prose, so a model lifts it and the validator proves the lift by
finding every sentence inside the shot it names. Its two halves take their refusals from
different rows: the bought bytes are published as they arrived, because stage 8 cuts what
came back, while where a line sits is refused rather than nudged, because stage 7 refuses a
length no model renders. It cannot fulfil any of the four sound modes on its own, since all
of them include music and effects, so it reports what is missing and the row below it buys
exactly that.
Stage 10 is the first that **rewrote its own row of the contract**, and the first whose
verdict cannot prove its result is faithful to its input, both deliberate, both written
down. The row said music and effects were an *input* a person brings, and admitted it did
not settle where they come from; it cannot be built that way, because pulling outside files
into the workspace is stage 0's monopoly, so "a person brings them" was a rewrite of stage 0
under another name. So it buys them, which adds no fourth provider, only a fourth and fifth
call site at the one stage 9 already uses. And it is where **"lifted, not invented" runs
out**: a music prompt is an instruction, which rule 9 writes in English, while the `Audio`
prose it comes from is material, which rule 9 forbids translating, so copying is illegal in
both directions and there is nothing verbatim to look for. What stands in its place is stage
4's bargain rather than stage 9's: a wiring verdict that never reads a prompt, whose load
is carried by one check: a cue's declared shots must be exactly the shots its seconds cover,
so a shot dropped and a shot invented fail the same way. Its bill is seconds rather than
calls, for a different reason than stage 9's: this provider rates per minute of generated
audio and charges at generation, so one call for a bed and one for a click are the same
count and nothing like the same money. It rebuilds from `episode.mp4` rather than laying
music over `narrated.mp4`, which is the only arrangement that encodes the speech once and
the only one in which music can honestly step back under a voice, and `narrated.mp4`
becomes a reviewed intermediate whose yes stage 10 gates on rather than reproduces.

## Project Structure

```
src/
├── index.ts          # Package API: re-exports what consumers need
├── bin.ts            # Executable: shebang, streams, exit code
├── cli.ts            # Single-file form: run(argv): Promise<Result<string>>
├── cli.test.ts
├── cli.usage.test.ts # The freeze: --help byte for byte, one snapshot per usage line
├── __snapshots__/    # What the freeze compares against
├── config/
│   └── index.ts      # App-level config (imports env, exports typed config)
├── site/             # Folder form: the published page; not a pipeline domain
│   ├── index.ts      # Public: freezeRelease, buildSite, publishMedia
│   ├── freeze.ts     # Process entry: one episode out of the workspace
│   ├── build.ts      # Process entry: the page
│   ├── publish.ts    # Process entry: the media
│   ├── worker.ts     # Process entry: how one published file is served: the bucket
│   ├── schema.ts     # Internal: the release registry, one file per release
│   ├── episode.ts    # Internal: the crossing: the only reader of the workspace
│   ├── render.ts     # Internal: the markup, and the English machine twin
│   ├── media.ts      # Internal: where heavy files live, and how one gets there
│   ├── index.test.ts # The build and the publisher, through the entry
│   ├── episode.test.ts
│   └── worker.test.ts
└── lib/
    ├── env.ts        # Single-file form: loads .env files, validates with Zod
    ├── env.test.ts   # Co-located test for env validation
    ├── workspace.ts  # Single-file form: the ONLY module that knows the layout
    ├── workspace.test.ts
    ├── text-model/    # Folder form: one billed text call, shared by stages 1, 3 and 4
    │   ├── index.ts       # Public: runTextStage and what a stage brings to it
    │   ├── client.ts      # Internal: transport, redaction, refusal classification
    │   └── attempt.ts     # Internal: lock, submitted, archive, resume, publish
    ├── image-model/   # Folder form: one billed image call, shared by stages 2 and 5
    │   ├── index.ts       # Public: runImageStage, attach, frameSize, referenceLimit,
    │   │                  #         validateImage, readImageResponse
    │   ├── track.ts       # Internal: what a track accepts: the frame, the limit
    │   ├── client.ts      # Internal: both endpoints, redaction, the 24 h download
    │   ├── validate.ts    # Internal: the PNG and response verdicts, pure and offline
    │   └── attempt.ts     # Internal: submitted, archive, resume, publish
    ├── media-prompt/  # Folder form: the prompt a model receives: text + attachments
    │   ├── index.ts       # Public: readSendPlan, what a future paid call carries
    │   ├── prompt.ts      # Internal: the blocks around a published direction
    │   └── plan.ts        # Internal: ids resolved per track, and the gate that follows
    ├── artifact/     # Folder form: provenance shared by every stage
    │   ├── index.ts      # Public: the stage-file shape, digests, writes, review
    │   ├── schema.ts     # Internal: <stage>.stage.json, one shape for all stages
    │   ├── store.ts      # Internal: bytes, digests, the single dry-run gate
    │   └── review.ts     # Internal: digest verification and creative approval
    ├── project/      # Folder form: index.ts is the only entry (stage 0)
    │   ├── index.ts      # Public: initProject, addEpisode, setEpisodeSettings,
    │   │                 #         addCharacter, addCharacterSources, setCharacterBasis,
    │   │                 #         checkStage0, approveStage0,
    │   │                 #         readStage0Inputs, readStage0Character
    │   ├── schema.ts     # Internal: Zod schemas for the artifacts
    │   ├── template.ts   # Internal: the project.md scaffold
    │   └── index.test.ts # Tests through the entry
    ├── screenplay/   # Folder form: index.ts is the only entry (stage 1)
    │   ├── index.ts      # Public: generateScreenplay, checkScreenplay, approveScreenplay,
    │   │                 #         validateScreenplay, readScreenplayScenes, buildPrompt
    │   ├── prompt.ts     # Internal: the prompt constant and its declared version
    │   ├── validate.ts   # Internal: the structural verdict, pure and offline
    │   ├── review.ts     # Internal: verification and approval bound to digests
    │   ├── generate.ts   # Internal: order of operations around the paid call
    │   ├── index.test.ts    # Validator and prompt, through the entry
    │   └── generate.test.ts # Generate/check/approve, through the entry
    ├── character/    # Folder form: index.ts is the only entry (stage 2)
    │   ├── index.ts      # Public: generateCharacter, checkCharacter,
    │   │                 #         approveCharacter, buildPrompt, referencePlan
    │   ├── prompt.ts     # Internal: the three prompts, the view order, the
    │   │                 #            reference plan, the frame of each artifact,
    │   │                 #            and the declared version
    │   ├── plan.ts       # Internal: the gates, and what an artifact is drawn from
    │   ├── generate.ts   # Internal: the command: targets, lock, preview, series
    │   ├── review.ts     # Internal: per-image verification and approval
    │   ├── index.test.ts    # Prompts and the reference plan, through the entry
    │   └── generate.test.ts # Gates/resume/approve, through the entry
    ├── shot-list/    # Folder form: index.ts is the only entry (stage 3)
    │   ├── index.ts      # Public: generateShotList, checkShotList,
    │   │                 #         approveShotList, validateShotList, buildPrompt
    │   ├── prompt.ts     # Internal: the prompt constant and its declared version
    │   ├── validate.ts   # Internal: parses as it validates; returns the plan as data
    │   ├── plan.ts       # Internal: what stage 3 reads, and whether it may pay
    │   ├── review.ts     # Internal: verification and approval bound to digests
    │   ├── generate.ts   # Internal: order of operations around the paid call
    │   ├── index.test.ts    # Validator and prompt, through the entry
    │   └── generate.test.ts # Gate/resume/approve, through the entry
    ├── prompt-package/ # Folder form: index.ts is the only entry (stage 4)
    │   ├── index.ts      # Public: generatePromptPackage, checkPromptPackage,
    │   │                 #         approvePromptPackage, validatePromptPackage, buildPrompt
    │   ├── prompt.ts     # Internal: the prompt, the answer schema, the declared version
    │   ├── validate.ts   # Internal: the wiring verdict; never reads a prompt
    │   ├── render.ts     # Internal: the answer split into manifest and prompt files
    │   ├── plan.ts       # Internal: the two gates, and what stage 4 reads
    │   ├── review.ts     # Internal: verification and approval bound to digests
    │   ├── generate.ts   # Internal: the command: publish, preserve, sweep
    │   ├── index.test.ts    # Wiring verdict and prompt, through the entry
    │   └── generate.test.ts # Gates/resume/approve, through the entry
    ├── references/   # Folder form: index.ts is the only entry (stage 5)
    │   ├── index.ts      # Public: generateReferences, checkReferences,
    │   │                 #         approveReferences
    │   ├── plan.ts       # Internal: which references are ready, and the three
    │   │                 #            obstacles that belong to the command
    │   ├── generate.ts   # Internal: the command: targets, lock, preview, series
    │   ├── review.ts     # Internal: per-image verification and approval
    │   └── index.test.ts    # Graph gate/series/resume/approve, through the entry
    ├── opening-frame/ # Folder form: index.ts is the only entry (stage 6)
    │   ├── index.ts      # Public: generateOpeningFrame, checkOpeningFrame,
    │   │                 #         approveOpeningFrame
    │   ├── plan.ts       # Internal: the cross-stage gate, and whether it may pay
    │   ├── generate.ts   # Internal: the command: one lock, one preview, one call
    │   ├── review.ts     # Internal: verification and approval of the one frame
    │   └── index.test.ts    # Gate per track/resume/regenerate/approve, through the entry
    ├── video-model/   # Folder form: one billed video job, shared by stage 7 and on
    │   ├── index.ts       # Public: runVideoStage, clipDuration, validateVideo
    │   ├── client.ts      # Internal: submit, poll, download; redaction
    │   ├── attempt.ts     # Internal: submitted + jobId before the poll, archive,
    │   │                  #            resume by asking, publish both files
    │   ├── validate.ts    # Internal: the MP4 verdict and the task's three shapes
    │   └── index.test.ts  # The order of operations around a paid job
    ├── clips/        # Folder form: index.ts is the only entry (stage 7)
    │   ├── index.ts      # Public: generateClips, checkClips, approveClips
    │   ├── plan.ts       # Internal: the chain, and the one refusal that is
    │   │                 #            stage 7's own: a duration nobody renders
    │   ├── generate.ts   # Internal: the command: two media, one lock, one bill
    │   ├── review.ts     # Internal: per-artifact verification, in both media
    │   └── index.test.ts    # Chain/two media/duration refusal, through the entry
    ├── assembly/     # Folder form: index.ts is the only entry (stage 8)
    │   ├── index.ts      # Public: generateAssembly, checkAssembly, approveAssembly,
    │   │                 #         ffmpeg, the engine a caller injects
    │   ├── plan.ts       # Internal: the cut derived from the shot list, and the
    │   │                 #            gate over another stage's approved clips
    │   ├── mux.ts        # Internal: everything known about ffmpeg: where, which
    │   │                 #            version, how a stream copy is spelled
    │   ├── generate.ts   # Internal: the command: one lock, one cut, no bill
    │   ├── review.ts     # Internal: the verdict on the whole, and the approval
    │   └── index.test.ts    # Gate/derived plan/drift/no-engine, through the entry
    ├── voice-model/   # Folder form: one billed speech call (stage 9)
    │   ├── index.ts       # Public: runVoiceStage, validateSpeech, billedCharacters,
    │   │                  #         utteranceLength
    │   ├── client.ts      # Internal: the endpoint, the container, redaction
    │   ├── attempt.ts     # Internal: submitted, archive, resume, publish
    │   ├── validate.ts    # Internal: the WAV verdict, pure and offline
    │   └── index.test.ts  # The verdict, the bill, the limit, through the entry
    ├── narration/    # Folder form: index.ts is the only entry (stage 9)
    │   ├── index.ts      # Public: generateNarration, generateMix, checkNarration,
    │   │                 #         checkMix, approveNarration, approveMix,
    │   │                 #         validateNarration, readDirection, setDirection
    │   ├── prompt.ts     # Internal: the instruction that forbids writing anything
    │   ├── validate.ts   # Internal: the verdict, including "lifted, not invented"
    │   ├── delivery.ts   # Internal: how the narrator reads, and why that is a file
    │   │                 #            of its own rather than a field in project.json
    │   ├── plan.ts       # Internal: two gates, and plan seconds resolved per track
    │   ├── generate.ts   # Internal: the script, then the lines it authorises
    │   ├── mix.ts        # Internal: the per-track half; buys nothing
    │   ├── review.ts     # Internal: two reviews, because there are two levels
    │   └── index.test.ts    # Lift/gate/bill/placement, through the entry
    ├── audio-model/   # Folder form: one billed audio call (stage 10), two endpoints
    │   ├── index.ts       # Public: runAudioStage, validateAudio, musicLength, effectLength
    │   ├── client.ts      # Internal: /v1/music and /v1/sound-generation, redaction
    │   ├── attempt.ts     # Internal: submitted, archive, resume, publish
    │   ├── validate.ts    # Internal: the MP3 verdict, walked frame by frame, offline
    │   └── index.test.ts  # The walk, the limits, through the entry
    ├── sound-design/  # Folder form: index.ts is the only entry (stage 10)
    │   ├── index.ts       # Public: generateSoundDesign, generateMaster, checkSoundDesign,
    │   │                  #         checkMaster, approveSoundDesign, approveMaster,
    │   │                  #         setLevels, validateSoundDesign
    │   ├── prompt.ts      # Internal: the instruction that carries rule 9 alone
    │   ├── validate.ts    # Internal: the wiring verdict; never reads a prompt
    │   ├── levels.ts      # Internal: how loud it sits, and why that is its own file
    │   ├── plan.ts        # Internal: two gates, placement, and what is still missing
    │   ├── generate.ts    # Internal: the cue sheet, then the stems it authorises
    │   ├── mix.ts         # Internal: the per-track half; buys nothing
    │   ├── review.ts      # Internal: two reviews, because there are two levels
    │   └── index.test.ts  # Wiring/gate/bill/refusal, through the entry
    ├── muxer.ts      # Single-file form: the local engine, shared by stages 8, 9 and 10
    ├── muxer.test.ts
    ├── timeline.ts   # Single-file form: the plan's clock as one film's, stages 9 and 10
    ├── result.ts     # Result<T>: the recoverable-error contract
    └── result.test.ts
```

`lib/artifact` exists because five stages now write the same state file, and
`lib/text-model` because three stages make the same paid text call. A stage never reaches
into another stage's internals: shared pieces are promoted out instead. When stage 4 became
the third text stage, `lib/text-model` grew from transport alone to the whole lifecycle
(lock, `submitted` before the POST, archive, resume from a saved answer, publish only what
validates), because that order *is* the contract and three copies of it would have made an
invariant into a coincidence. A stage now brings its prompt, its verdict and its files;
the sequence is not its business. Do the same with the next thing two stages copy.

`lib/video-model` exists because that promise came due. A clip is an asynchronous job: the
POST answers with an id, the work happens somewhere else, and the result arrives through
polling and two signed URLs. That is a different order of operations from a request that
answers with the picture, and the order of operations *is* the contract of a billed call,
so it is a module, not a flag. It also holds what is true of any clip: how long one may be,
and the verdict on the bytes, read from the MP4's own boxes rather than from a decoder, so
that `check` works on a machine with no media tools on it.

`lib/clips` therefore buys from **two** media modules, and that is the honest shape of the
stage rather than a compromise: stage 7 produces an image and a video, the stage brings its
artifacts, and each medium brings its own lifecycle. Splitting the stage in two instead
(one module for entry frames, one for clips) would have put the chain that binds them
across a module boundary, and the chain is the stage.

`lib/image-model` was promoted at the **second** caller, not the third, and the difference
is deliberate. With `text-model` the third stage was a discovery; here stage 6 is a
contracted certainty that draws one image exactly the way stage 5 does, so waiting would
have been choosing to repeat a mistake already paid for: the two copies of the text
lifecycle had drifted in their comments before anyone merged them. Stage 7 is **not** a
fourth caller: a video clip is an asynchronous job with an id to poll, which is a different
order of operations and earns its own module rather than a flag in this one. The promotion
also settled where a frame belongs: `1920x1920` is a fact about a character sheet, so it
stays in `lib/character`, while "which endpoint, and how the bytes travel" is true of any
image and moved out.

`lib/media-prompt` exists because a prompt to an image or video model is only half written
when stage 4 publishes it. It cannot live inside `lib/prompt-package`, which is the one
artifact forbidden to name a track, and it cannot live inside stage 5, which stages 6 and 7
would then have to reach into. Resolving `hero:ewa` to a file per track is also what answers
the gate: an attachment nobody accepted is not one this pipeline sends, so the list and
the verdict on it are one question asked once. Stage 2 keeps its own numbering: rule 8 fixes
the *position*, and what follows the equals sign is each stage's vocabulary, which for stage
2 is file names because its references never had manifest ids.

`lib/muxer` is that promise come due. `lib/assembly` kept ffmpeg inside it while stage 8
was its only caller, because a module promoted for one caller is a widened interface bought
with nothing, and this file said that if stage 9 turned out to mix with the same program,
that would be the second caller and the promotion would happen then. It does, so it did:
at the caller, not at the guess. The module grew one operation and kept its shape:
**operations, never a process**. There is no `run(args)` in it, because a generic escape
hatch would let any caller spell anything, which is the widened interface it exists to
prevent. A stage says what it wants done; how ffmpeg says it stays inside.

`lib/voice-model` exists for the reason `lib/video-model` does: the order of operations
*is* the contract of a billed call, and a speech call's is not a text call's. A text call
answers with a document this pipeline then validates as prose; a speech call answers with
bytes, and what it charges for is not the answer but the question, because this provider
bills per character of the text it is handed. So the number every stage prints before it
spends, the count of calls, stops being the bill here, and both numbers are printed instead.

`narration/delivery.ts` is where a decision went **because of where it must not go**, and
that is the general lesson rather than a stage-9 detail. Stage 9's first recordings came
back flat, and nothing in the code was wrong: the stage had nowhere to say how the narrator
reads, so every call went out on the provider's defaults, which are `stability: 0.5` and
`style: 0`, the flattest configuration the endpoint offers. A missing decision is not a
missing number; it is a missing place to put one, and the fix is a place, not a constant.

The obvious place was `project.json`, beside `narratorVoiceId`, since a reading recurs
between episodes exactly as a cast does. It is the wrong one. `project.json` is a recorded
input of nearly every artifact in the workspace (in one real project, ~89 records, up to
both tracks' approved `episode.mp4`), so a knob somebody is *expected* to turn, because it
is dialled in by ear over several attempts, would lapse the approval on rendered clips and
on a cut episode whose bytes it never touched. **Where a decision lives decides what
changing it invalidates**, so a file that is a recorded input of everything can only hold
decisions nobody revisits. The reading lives beside `project.json`, in a file stage 9 owns
and no earlier stage reads, and is a recorded input of the bought recordings alone.

The seam that falls out of this is real rather than convenient: **the voice is casting** and
belongs with the cast in stage 0; **the reading is direction** and belongs to the only stage
able to hear it. Defaults are allowed here because these five have the provider's own, which
is the reading that lets `AIMATOR_FFMPEG` be optional, but they are sent **explicitly** on
every call, so the request archive answers what produced these bytes instead of deferring to
whatever the provider's defaults were that month.

The same module is also why `producer.kind` has three values instead of two. It is worth
saying plainly, because a schema change in a shared module is the kind of thing that looks
like convenience: `manual` means a person decided and the tool copied, `model` means a paid
call, and neither is true of a file a local program wrote. The record exists to answer "what
would have to run again to get these bytes", and for a muxed file the honest answer is the
engine and its version: two releases do not necessarily write the same container from the
same clips. `manual` would have made that unanswerable from the file, which is the exact
failure `producer` was built to prevent.

`lib/audio-model` is the fifth kind of billed call, and it is a module rather than a flag in
`lib/voice-model` for the reason `lib/video-model` is one rather than a flag in
`lib/text-model`: what a module of this kind holds is the contract of a *kind* of call, and
speech and music are not one kind. A speech call is handed a sentence and charges for the
sentence; these two are handed a description and charge for **the length of audio they are
asked to produce**. That changes the number a stage must print before it spends, which is
the one thing every paid stage here is required to get right. Two endpoints behind one entry
follows `lib/image-model`, and is truer here: one provider, one key, one container, one
verdict, one lifecycle, and a body that differs by a URL and a field name.

`lib/timeline` is a promotion at the **second** caller, on `lib/image-model`'s judgement
rather than `lib/text-model`'s. Two clocks have existed since stage 7 (the plan's and each
finished film's), and every stage that lays sound on a picture has to cross the gap between
them. Stage 9 crossed it for an utterance anchored at "7s of the plan"; stage 10 crosses it
for a thunderclap and for the second a bed begins. The arithmetic is not a formula anybody
would want written twice, and stage 10 was a certainty rather than a discovery, so waiting
for a third caller would have been choosing to make an invariant into a coincidence on
purpose. `readAcceptedLines` moved the other way and is worth distinguishing: it was not
promoted into a module but **exported from stage 9's own entry**, because "which lines did a
human accept" is a question about stage 9's artifact, and a later stage consuming an earlier
stage's artifact through its public entry is the ordinary direction.

`lib/muxer` grew a **third operation**, `master`, and did not absorb `mix` into it although
it is a superset. They answer different questions and both stay: `mix` produces the film a
human listens to in order to judge **placement**, with nothing else in the way, and `master`
produces the film with everything in it. Collapsing them would delete the only artifact in
the pipeline where the narration can be heard on its own, which is also the artifact stage
10's gate reads a yes from.

`sound-design/levels.ts` is `narration/delivery.ts` one row down, and the interesting part
is why it is not *inside* it. Delivery is a recorded input of the bought recordings; levels
are a recorded input of the mix. How loud the bed sits under a narrator says nothing about
how that narrator read, so changing the mix must not lapse a recording, the same reasoning
that keeps delivery out of `project.json`, applied one level finer. **Two knobs, two scopes,
two files.** Its defaults need their own justification, because delivery's is unavailable:
delivery could point at the provider's documented defaults and there is no provider here.
The one that applies is different and stronger: **this decision cannot be made before it is
heard**, so refusing the first mix would demand an answer nobody is in a position to form,
and a mix costs nothing to redo.

It **grew** with stage 7 rather than being copied: resolving `opening-frame`, `entry:Cnn`
and `end:Cnn` per track is the same question it already answered for `hero:ewa` and `Rnn`,
against the same three stage files. `end:Cnn` is also the first id no planning stage wrote:
stage 4 has no word for a frame that does not exist until a clip has been rendered and
accepted, so the sender mints it and prints it in the list. Rule 8 binds the planner to
ids the sender will list; it does not stop the sender from carrying one the planner could
not have known. The composer learned the same lesson one level down: a clip is told to
continue from its first image, not to compose one, and the free preview says exactly what
the paid call will.

`src/site` sits **beside** `src/lib` rather than inside it, and that is the whole point of
where it is: it is not a stage, it consumes no stage's artifacts and it never reads
`AIMATOR_WORKSPACE`. A release names a frozen export directory under `out/`, which is what
lets the page be rebuilt from the repository long after the workspace has moved on to the
next episode, and it is also what keeps rule 3 intact, because the module joins the
repository's own paths and never the workspace's. Its contract is one promise carried one
level up from `approve`: **a published release never changes.** Every file it copies is
checked against the sha256 the registry recorded, so an export edited after publication
fails the build instead of quietly replacing an asset whose cache is a year long. This is
acceptance bound to bytes, read at the point where the bytes leave the machine.

A release's bytes live in **two places, split by what they are**, and the split is the
interesting part. Text is committed: the episode's source file and each stage's document
sit under `site/`, because they are small, they are worth reading in a diff, and the page
quotes them rather than linking them. Media go to a private R2 bucket, because films are
streamed rather than read and a bucket is the only copy of them that survives the laptop
that made them. `buildSite` therefore needs **nothing** from `out/`: a fresh clone rebuilds
and redeploys the page while the films stay exactly where they were, which is the property
the whole arrangement exists for. Only `publishMedia` reads the frozen exports, and only to
hand them over, after checking each one against the registry, so re-publishing can write
the same file again and nothing else.

`media.ts` is `lib/muxer` one row up: **operations, never a process.** A caller says
"publish this file"; how wrangler spells an upload stays inside, so a bucket rename or a
move to the S3 API is one file's problem.

`episode.ts` is the **crossing**, and it is the one place here that reads
`AIMATOR_WORKSPACE`, which is exactly why the other two never have to. It takes a finished
episode out of the workspace, re-encodes its films for the web, scales its pictures,
measures what it produced and writes the registry. It reads the workspace through
`lib/workspace.ts` and every artifact through its own stage's public entry, so rule 3 holds
and nothing reaches into a stage. It is **not** in `lib/muxer` because it re-encodes, and
that module's whole promise is that it copies streams and never does; CRF and scale are
facts about the web rather than about the film, so they live with the publisher.

What it deliberately will not do is write the prose. Every text a reader sees comes out as
the literal `TODO`, and `buildSite` refuses a registry that still says so, naming the
fields. That is **rule 7 one level up**: a description nobody has written is undecided, and
the gate blocks rather than publishing the word `TODO` to the internet. Both sides use one
walk over the registry, so they cannot disagree about what counts as unwritten. The
exception proves the rule: a reference's `subject` is *lifted* from the prompt package,
because it is the English line the model received and retyping it would be a second version
of the same truth.

It has **four process entries**, for the reason the package has `bin.ts`: `freeze.ts` owns
the crossing, `build.ts` the page, `publish.ts` the media, and `worker.ts` how one published
file is served, which is a different question from what gets published. None is an internal
of another, and `index.ts` stays three functions so all three are tested by calling them,
the publisher with a fake uploader rather than a real bucket, and freezing with an injected
`Encoder`, exactly as `lib/assembly` takes an injected `Muxer`.

The worker got **simpler** by moving the media out. When films were deployed assets, Static
Assets answered a Range request with 200 and the whole file, so the worker had to read the
stream and discard everything before the requested offset. R2 takes an offset, so the bytes
a viewer asked for are the only ones read. The bucket stays private and the worker is its
only reader, on the site's own origin, which is also what lets the page keep
`default-src 'self'` and what keeps a download link a download.

The page itself is the second half, in `site/`, and it is deliberately the same shell as
[vaideo.auditmos.com](https://vaideo.auditmos.com/): both are the "portable website shell"
of the [Auditmos design manual](https://auditmos.com/design.md), so content, subdomain and
default language differ and the appearance does not. Do not invent a second theme here.
The one inversion is language: Polish is primary and English is the translation block,
because this repository's documentation and this film are Polish, while `index.md` and
`llms.txt` stay English as the machine version. What a release may publish, and what it may
not, is in [docs/strona.md](docs/strona.md).

## Pipeline rules

Nine rules that stop an agent from re-creating the mess this tool was built to replace.
Full contract in [docs/pipeline.md](docs/pipeline.md).

1. **One state filename: `<stage>.stage.json`.** One shape for every stage. Never invent
   `screenplay-state.json`, `references-state.json` or `downstream-status.json`. One file
   per stage **per directory the stage writes to**: stage 2 holds one per character per
   track, and stage 9 holds one under the episode and one under each track, because its
   words are shared and its mix is not.
2. **The image-model track is a directory level** (`gpt-image/`, `seedream/`), never a
   filename prefix and never a parallel tree. **A character is a directory level too**
   (`characters/ewa/`, `characters/tata/`), for the same reason.
3. **Paths come from `src/lib/workspace.ts` only.** No other module joins path segments.
4. **A run archive never copies an input.** Inputs are referenced by path + sha256.
5. **No document in this repo records project state or progress.** State is a file read
   in the workspace; history is `git log`. `docs/pipeline.md` describes the current
   contract in the present tense and is edited in place, never appended to.
6. **Validation is not approval.** A `check` command verifies and writes nothing; only an
   explicit `approve` records acceptance, only over artifacts that already validate, and
   only bound to their current digests. Never let a passing check imply a human said yes.
7. **A decision with no default is stored, never inferred.** An absent file, an empty
   directory or a missing flag means undecided, and the gate blocks; it never stands in
   for an answer the user did not give. The mirror of this is just as binding: what an
   approved artifact already says is **derived, never re-stored**. Stage 8's edit plan is
   the approved shot list read in order, not an `edit-plan.json`, for the reason stage 3
   refuses a `shot-list.json` and stage 4 refuses to write down the clip chain: two files
   holding one truth drift at the first hand correction.
8. **A prompt to an image or video model is text *plus* ordered attachments, and the text
   addresses them by position.** The sending stage prints `Image N = <id> — <role>` ahead
   of the task, generated at call time and never stored; a planning stage may write an id
   into prose only because that list is guaranteed. Never a filename, a path or a track
   name; the id resolves to a file at the sender, per track, which is what lets one prompt
   package serve both. `character/prompt.ts` shows the shape; stages 5–7 owe the same. It
   does not bind stage 9: a speech call carries no attachments, and the whole purpose of the
   list is addressing one by position.
9. **An instruction to a model is written in English; material the model works from stays
   in the language it was authored in.** Role decides, not readership. Every stage's task
   text and every artifact that is itself a prompt (`prompts/**`, including its `subject`
   labels, which reach the model in the attachment list) are English. `project.md`,
   `source.md`, `screenplay.md` and `shot-list.md` travel verbatim and are never translated:
   their digests are recorded, and a translation is a second version of the same truth. A
   request is therefore often bilingual, by design. `language` is the film's language, what
   is spoken and captioned on screen, and never the language of a prompt.

## Deep Modules

Small interface, large implementation (Ousterhout). A module absorbs complexity behind a narrow entry point instead of spreading it across many tiny files. **Every implementation in this repo follows this.**

### Decision checks

- Before creating a file: does this **deepen** an existing module, or only **widen** its interface?
- Before adding an `export`: does a caller actually need this, or is it internal?
- Every export from an `index.ts` declares an explicit return type; the interface is the contract
- Many small files that each do very little are shallow modules; they add system complexity instead of hiding it

### Module boundaries

| Layer | Boundary | Interface (narrow) | Hides |
|-------|----------|--------------------|-------|
| Package API | `src/index.ts` | Only what consumers import | Everything else under `src/` |
| Domain | `src/lib/{domain}/index.ts` | Exported functions + types | Helpers, adapters, I/O, third-party types |
| Config | `src/config/index.ts` | Typed `config` object | Env wiring, defaults, coercion |
| Env | `src/lib/env.ts` | `env` | Zod schemas, `.env` loading, `process.env` access |
| Layout | `src/lib/workspace.ts` | Path builders + id rules | Every directory and file name in the workspace |
| CLI | `src/cli.ts` | `run(argv): Promise<Result<string>>` | Argument parsing, usage text, command dispatch |
| Executable | `src/bin.ts` | none, a process entry | `process.argv`, stdout/stderr, exit code |

`bin.ts` stays a shim on purpose: keeping streams and exit codes out of `run()` is what lets the CLI be tested by calling a function instead of spawning a process. `run` is async because stages write files and later stages call HTTP, but it still never touches `process`, a stream or an exit code, which is the invariant that matters.

### Growth path

A domain starts as **one file**: `src/lib/{domain}.ts`. When it grows internal parts, promote it to a folder: `src/lib/{domain}/index.ts` becomes its only entry, and siblings (`client.ts`, `schema.ts`, `queries.ts`) stay internal.

Never reach into another domain's internals; import from its `index.ts`, or promote the shared piece into a module of its own.

Don't split on file size alone. Past ~500 lines, split by **subdomain**, not by function count.

### Enforcement

- `pnpm unused` (Knip) fails on unused exports: an export no caller needs is a widened interface. Runs in CI.
- `performance/noBarrelFile` is deliberately `off` in `biome.jsonc`: an `index.ts` barrel *is* the module interface here
- Tests import the module entry only (see Testing Conventions)

## Type & Error Design

Biome and `tsconfig` already enforce the mechanical rules: `noExplicitAny`, `noUncheckedIndexedAccess`, `useForOf`, kebab-case filenames, `noParameterProperties`. Those are not repeated here. What tooling cannot check:

- Prefer discriminated unions over boolean flags, never `{ success: boolean; data?: T; error?: E }`
- Return `Result<T>` (`src/lib/result.ts`) for recoverable errors; let unexpected errors propagate to the caller
- Throw typed error classes extending `Error`, never a bare `new Error(string)`

```ts
class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

function parsePort(raw: string): Result<number> {
  const port = Number(raw);
  return Number.isInteger(port) ? ok(port) : err(new ValidationError("port", raw));
}
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Build with tsup (ESM + declarations) |
| `pnpm dev` | Run the CLI from source with tsx (no build step) |
| `pnpm lint` | Check code with Biome |
| `pnpm lint:fix` | Auto-fix lint/format issues |
| `pnpm types` | Type-check with tsc --noEmit, **two projects, one command**. `tsconfig.json` holds `src` alone, because `rootDir: "src"` is what tsup reads when it rolls up the declarations and a wider root would move them. The configs in the repo root are therefore a second project, `tsconfig.tools.json`, which `include`s `*.config.ts` and which the root **references**, not for `tsc -b`, which nothing here runs, but because a referenced project is the only thing that makes the editor's language server put those files in it. Without the reference they land in an inferred project, type-checked against TypeScript's defaults instead of this repo's `strict`, and nothing in CI reads them at all. A new config in the root is covered the moment it is named `*.config.ts`, and silently uncovered if it is not. |
| `pnpm test` | Run tests with Vitest |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm unused` | Detect unused code with Knip |
| `ffmpeg` | Not a script but a **system** dependency stages 8, 9 and 10 need on `PATH`, or at `AIMATOR_FFMPEG`. Nothing else in the repo uses it, and `check` deliberately does not: it reads MP4 boxes and MP3 frames, so a cut, a narrated cut and a full mix can all be verified on a machine with no media tools. Absent, those stages refuse rather than re-encoding. |
| `pnpm update` | Interactive dependency updates with Taze |
| `pnpm site:freeze` | `<project> <episode> <version>`: take one finished episode out of the workspace, re-encode it for the web and write a registry whose prose is still `TODO` |
| `pnpm site:build` | Build the release page into `out/site`; needs no frozen export on disk |
| `pnpm site:media` | Put every registered release's films and stills in R2, checksum-gated |
| `pnpm site:preview` | Build it, then serve it on the real Workers runtime, reading the real bucket |
| `pnpm site:deploy` | Build, publish the media, then publish **every** registered release to `aimator.auditmos.com` |

## Testing Conventions

- Tests are **co-located** next to source files: `foo.ts` → `foo.test.ts`
- Use **TDD** with vertical slices (red → green → refactor, one test at a time)
- Test **behavior through public interfaces**, not implementation details
- If a test needs to import an internal file, the module boundary is wrong; test through its `index.ts`
- Run tests: `pnpm test`

### The one test with no source file beside it

`src/test/docs.test.ts` is the exception to co-location, and it earns it by having no
module to sit next to: its subject is the documentation. It reads the pages under `docs/`
and `README.md` and checks them against `run(["--help"])`: every documented command and
flag has to exist in the usage text, every local link has to resolve, and every implemented
stage has to have a page. It sits in `src/test/` for the reason the fixture does, and it
still tests through a public interface: the usage text arrives by calling `run`, not by
reaching into the parser.

**It lists no command and no flag of its own.** Both sets are parsed out of `--help`,
because a second copy of that list is the very drift the test exists to catch. The set of
legal commands comes from the usage lines, so a second word counts as a subcommand only
when the usage text pairs the two, which is what keeps `approve dzielna-ewa` an argument
and `character generte` an error.

### The shared fixture

`src/test/fixture.ts` builds an episode through stages 0 to 4 (the pipeline every image
stage needs before it can test anything), and, through `makeTrack`, a finished one through
stages 5, 6 and 7. It is **not a domain**: nothing under `src/lib` imports it,
`src/index.ts` does not re-export it and `tsup` does not bundle it, which is why it sits
outside the layer table rather than inside it.

`mp3` joined `wav`, `mp4`, `png` and `jpeg` at stage 10, and is built rather than committed
for their reason. It carries exactly what the verdict reads: a chain of frame headers, each
declaring its own bitrate and rate, plus the two cases that make the reader worth having:
`bitrate` takes a list, so a variable stream exists to be read exactly, and `id3` writes a
tag whose payload **looks like a frame header**, so honouring the declared size is the only
way to get the length right. A fixture that filled the tag with zeroes would have passed
against a reader that simply hunted for the first sync byte.

`makeCut` joined them at stage 9, which is the first stage that needs an episode already
assembled and needs one on both tracks. Stage 10 is its second caller and needed no change
beyond `clipSeconds`, which was already there: a track whose clips came back a little short
is the only way an effect legal against the plan can overrun the real film, and a track
whose clips came back long is the only way a bed bought at the plan's length can leave
silence at the end. Those are the two halves of "refused versus reported", and the fixture
could already produce both. It carries the fixture's own `muxer`, because the
clips this fixture builds are structurally valid MP4s rather than decodable ones; the real
engine is exercised where it is the thing under test, in `muxer.test.ts`, against inputs it
made itself. `NARRATION` and the `narration` option are the same line drawn again: the
shots carry what a narrator says only where a test asks for it, because a longer `Audio`
field would quietly change the prose stages 5 to 8 attach verbatim.

`makeTrack` was promoted for the same reason and at the same threshold as the rest of it:
stage 8 would have been the fourth copy of the stage 5-to-6 build-up and the second of stage
7's. It deliberately does **not** replace the instrumented transports stages 5, 6 and 7
bring to their own tests. Those count calls, because for a stage that bills per call the
count *is* the assertion; `makeTrack` only has to leave a correct track on disk. That is the
same line the fixture already draws around the manifest: what a stage tests, it owns.

It was promoted at the third copy, not the second. Stages 5 and 6 and `media-prompt` each
carried the same two hundred lines, byte-identical in `screenplay()`, `shot()` and
`shotList()`, and stage 7 was the fourth: the same threshold `lib/text-model` was promoted
at, and the same reasoning: three copies make an invariant into a coincidence.

It owns the **shot list**, and `shotList` chooses between three cuts of the same thirty
seconds. Two clips is the default; `three-clips` exists because two can only show one way
of seeding a later clip and stage 7 needs both; `unrenderable-clip` cuts the first one to
three seconds, which stage 3 accepts and no video model renders, so the refusal that
protects the film's timing has something to refuse. They are options rather than one shape
because the manifest each test brings has to name exactly the clips the shot list plans.

Two rules keep it from becoming a second place where behaviour hides.

**It builds through each stage's public entry**, never by writing artifacts. The one
exception is `makeHero`, which forges a stage-2 result because running the real stage would
mean a hundred fake HTTP calls before any test could start.

**It does not own the manifest.** Each test brings its own `answer()`, because the graph it
describes is the thing under test: stage 5 wants two roots and a dependent, stage 6 wants
one reference to wait for, `media-prompt` wants more attachments than a track will carry.
For the same reason `approvePackage` is a **required** field with no default: stage 5's
tests leave the package pending so they can test the refusal, stage 6's want it accepted,
and a default would have silently changed what one of them asserted.

## Commit Format

Conventional Commits enforced via commitlint:

```
<type>(<scope>): <description>

Types: feat, fix, refactor, test, docs, chore, ci, perf
```

Pre-commit hook runs `pnpm lint && pnpm test` automatically.

**The version is the tool's, not the site's.** `.releaserc.json` tells the commit
analyzer that `docs`, `chore`, `ci`, `test` and **anything scoped `site`** release
nothing, so only a change to the CLI moves the number. The first four are the ordinary
reading of a version; the scope is the one that had to be decided, and it was decided
after four releases in one day turned out to be four commits about the published page and
none about the pipeline. A tag that grows when the shop window is rearranged says nothing
about the thing on sale. A release of the *site* is a different artifact with its own
number, `site/releases/<version>.json`, written by `pnpm site:freeze`; the two share a
numbering scheme and nothing else, and they are free to disagree.

So the scope is what decides whether a commit ships, which makes `feat(site)` and `feat`
a real choice rather than a label. Scope a commit `site` when it changes what is published
at `aimator.auditmos.com`, and leave the scope off when it changes what the CLI does.

**An open issue labelled `blocks-release` holds every release.** A PRD implemented over
many commits is one version, not one per `feat`, and the number it earns is decided by all
of them together, so the CI release job checks for open issues with that label and skips
`semantic-release` while any exists. Put the label on the PRD issue when the work starts;
closing it after the last phase is what releases, with the notes of every commit since the
previous tag. Nothing in the workflow needs editing per PRD. The cost is deliberate: an
unrelated `fix` waits with the PRD, which is the right trade for a solo repository.

## Environment Variables

- Define schemas in `src/lib/env.ts` using `@t3-oss/env-core` + Zod
- `.env.example` is the committed reference; add every new variable to it
- `.env` and `.env.local` are both gitignored; `.env` holds your local values
- Access via: `import { env } from "./lib/env.js"`
- `env.ts` loads `.env.local` **before** `.env`, because `process.loadEnvFile` never
  overwrites a key that is already set, so the file read first wins. Precedence ends up
  shell > `.env.local` > `.env`. Do not "fix" the order.
- `AIMATOR_WORKSPACE` is optional in the schema on purpose: a missing workspace is a
  recoverable condition `run()` reports as a `Result`, not an exception at import time.
- One model variable **per image track** (`AIMATOR_IMAGE_MODEL_GPT_IMAGE`,
  `AIMATOR_IMAGE_MODEL_SEEDREAM`), because the two tracks are drawn side by side and a
  single shared variable would make running both from one shell an edit between commands.
  Neither has a default, for the same reason `AIMATOR_SCREENPLAY_MODEL` does not.
- One model variable **per paid call site**, so `AIMATOR_SHOTLIST_MODEL` is stage 3's own
  and `AIMATOR_PROMPTS_MODEL` is stage 4's, rather than a reuse of stage 1's: sharing one
  would mean that choosing a model for the screenplay quietly chose one for the shot list
  and for the prompt package, which nobody decided.
- `AIMATOR_VIDEO_MODEL` is **one variable for both tracks**, which is not an exception to
  the per-track rule but the same rule read correctly. The image models are per track
  because the two tracks are *drawn* side by side and a shared variable would make running
  both from one shell an edit between commands. A clip is not drawn: it is rendered from a
  frame that track already produced, by a model chosen once, so the axis is the call site.
  Its key is `BYTEPLUS_MODELARK` on both tracks, including `gpt-image`, because the key
  follows the model rather than the directory it writes into. Stage 7's entry frames reuse
  `AIMATOR_IMAGE_MODEL_<TRACK>` for the opposite reason: a different image model inside one
  track would put two hands on the same drawing.
- Stage 10 carries **three**, because it has three paid call sites: `AIMATOR_SOUND_MODEL`
  writes the cue sheet, `AIMATOR_MUSIC_MODEL` composes a bed and `AIMATOR_EFFECTS_MODEL`
  renders an effect. The last two are one variable each for **both tracks**, for the reason
  the voice model is: neither a bed nor a thunderclap is *drawn*, so neither knows which of
  the two films it will end up under. Two of them rather than one, because a shared variable
  would mean that choosing how the score sounds quietly chose how a thunderclap does. Their
  key is `ELEVENLABS_API_KEY`, stage 9's. **The key follows the provider, the variable
  follows the call site**, which is the same reading that gives `BYTEPLUS_MODELARK` to a
  clip on the `gpt-image` track.
- Stage 9 carries **two** model variables, because it buys from two providers:
  `AIMATOR_NARRATION_MODEL` lifts the script and `AIMATOR_VOICE_MODEL` reads it. The second
  is one variable for both tracks, for the reason `AIMATOR_VIDEO_MODEL` is: a spoken
  sentence is not drawn, so a voice has no idea which of the two films it will sit over.
  Neither carries the **voice**. Which voice reads the series is casting: it recurs between
  episodes exactly as the cast does, so it is stored in `project.json` as
  `narratorVoiceId`, and it gates stage 9 alone. In a variable, the second episode would get
  a different narrator from a different shell with nothing on disk saying anybody decided
  that, which is the silent default the cast was invented to remove.
- `AIMATOR_FFMPEG` is the only variable here that names a **program** rather than a model or
  a key, and the only one whose absence has a sensible answer. Every other one refuses a
  default because a model nobody chose is not a decision; "the ffmpeg on this machine" is
  not a choice between engines, it is the engine. The variable exists for a build that is
  not on `PATH`, never for picking a different tool.

## Development Workflow

1. Plan the change, exploring the existing code first
2. Before creating a file or adding an `export`, run the Deep Modules decision checks above
3. Implement with TDD in vertical slices (red → green → refactor, one test at a time)
4. Use the `environment-variables` skill when adding or changing env vars
5. Use the `bugfix` skill when something is reported broken: failing test first, then the fix
6. Use the `develop-series` skill when a user has an idea but cannot yet answer stage 0,
   then `prepare-project` to run stage 0 itself; those two own every creative interview,
   and neither develops an episode's plot, which belongs to stage 1
7. Commit with a conventional commit message; the pre-commit hook runs lint + tests

## Formatting Rules

- Biome with the `ultracite/biome/core` preset
- Line width: 100 (overrides the preset's 80)
- Indentation: 2 spaces (from the preset)
- Unused imports: warned
