		const qcSameModel = (a, b) => a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort;
		const qcModelActivityDefinition = {
			kind: "qc-model-activity",
			target: "chat",
			match: event => ["model/selection", "request/header"].includes(event.type) ? { id: String(event.seq), role: "start" } : null,
			start: (_context, { event }, reader) => {
				const previous = reader.previous("qc-model-activity")?.state;
				const next = event.type === "model/selection" ? event.data : event.data.header.config;
				const selection = { provider: next.provider, model: next.model,
					reasoningEffort: event.type === "request/header" && event.data.header.adapterDefaults?.reasoningEffort ? undefined : next.reasoningEffort };
				if (event.type === "model/selection") return {
					applied: previous?.applied, pending: selection, seq: event.seq,
					activity: qcSameModel(previous?.pending ?? previous?.applied, selection) ? null : "pending"
				};
				const matched = previous?.pending && qcSameModel(previous.pending, selection);
				const changed = previous?.applied && !qcSameModel(previous.applied, selection);
				return { applied: selection, pending: matched ? undefined : previous?.pending, seq: event.seq,
					activity: matched || changed ? "applied" : null };
			},
			update: context => context.state,
			buildViewNode: context => {
				const state = context.state;
				if (!state?.activity) return null;
				return chatNode(context, "qc-model-activity", state.seq, {
					activity: state.activity,
					selection: state.activity === "pending" ? state.pending : state.applied
				});
			}
		};
		function QcModelActivity({ node }) {
			const { activity, selection } = node.data;
			const effort = { off: "Выкл.", none: "Выкл.", minimal: "Минимальный", low: "Низкий", medium: "Средний",
				high: "Высокий", xhigh: "Очень высокий", max: "Максимальный" }[selection.reasoningEffort] ?? selection.reasoningEffort ?? "По умолчанию";
			const h = react.createElement;
			return h("div", { className: "qc-model-activity", "data-model-activity": activity },
				h("span", { "aria-hidden": true }, activity === "applied" ? "✓" : "↻"),
				h("strong", null, activity === "applied" ? "Настройки применены" : "Для следующего запроса"),
				h("span", { title: selection.provider }, selection.model + " · " + effort));
		}
		let qcStopSpeech;
		function QcReadAloud({ text }) {
			const [state, setState] = react.useState("idle");
			const playback = react.useRef(null);
			const stop = () => {
				const current = playback.current;
				if (!current) return;
				playback.current = null;
				current.abort.abort();
				if (current.audio) {
					current.audio.pause();
					current.audio.removeAttribute("src");
					URL.revokeObjectURL(current.url);
				}
				if (qcStopSpeech === current.stopPlayback) qcStopSpeech = undefined;
			};
			react.useEffect(() => stop, [text]);
			if (!window.dshDesktop?.voice || !text.trim()) return null;
			const play = async () => {
				if (playback.current) {
					stop();
					setState("idle");
					return;
				}
				qcStopSpeech?.();
				const current = { abort: new AbortController() };
				playback.current = current;
				qcStopSpeech = current.stopPlayback = () => { stop(); setState("idle"); };
				setState("loading");
				try {
					const wav = await window.dshDesktop.voice.synthesize(Array.from(text.trim()).slice(0, 8000).join(""), current.abort.signal);
					if (playback.current !== current) return;
					current.url = URL.createObjectURL(wav);
					const audio = current.audio = new Audio(current.url);
					audio.onended = () => { stop(); setState("idle"); };
					audio.onerror = () => { stop(); setState("error"); };
					await audio.play();
					if (playback.current === current) setState("playing");
				} catch {
					if (playback.current === current) { stop(); setState("error"); }
				}
			};
			const active = state === "playing" || state === "loading";
			const label = active ? "Остановить озвучивание" : state === "error" ? "Озвучивание недоступно · повторить" : "Озвучить ответ";
			const h = react.createElement;
			return h("button", { type: "button", className: "qc-read-aloud", "aria-label": label, "aria-pressed": active,
				title: label, onClick: play },
				h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
					strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
					h("path", { d: active ? "M7 7h10v10H7z" : "M11 5 6 9H3v6h3l5 4V5Zm4 4a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12" })));
		}
