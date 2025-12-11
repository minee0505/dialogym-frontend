import { useCallback, useEffect, useRef, useState } from "react";
import apiClient from "@/services/apiClient.js";
import useSessionStore from "@/stores/sessionStore.js";

/**
 * GPT Realtime + WebSocket 통합 Hook
 *
 * 역할:
 * 1. WebRTC P2P로 GPT와 음성 통신
 * 2. WebSocket으로 백엔드에 대화 내역 실시간 전송
 * 3. 재연결 시 대화 내역 복구
 * 4. 사용자: PTT (수동), AI: VAD (자동)
 */
export const useRealtimeSession = (scenarioId, userId) => {
    // 모든 Hook을 먼저 선언 (조건부 호출 방지)

    // webRtc 관련
    const pcRef = useRef(null);
    const localStreamRef = useRef(null);
    const dataChannelRef = useRef(null);
    const audioTagRef = useRef(null);

    // webSocket 관련
    const wsRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);
    const reconnectAttemptsRef = useRef(0);

    // 발화 시간 관련
    const userSpeakingStartRef = useRef(null);
    const aiSpeakingStartRef = useRef(null);
    const lastUserSpeakingTimeRef = useRef(null);
    const lastAiSpeakingTimeRef = useRef(null);

    // PTT 관련
    const [isPttActive, setIsPttActive] = useState(false);
    const [vadStatus, setVadStatus] = useState('idle');
    const pttTimerRef = useRef(null);

    // AI 음성 분석 관련
    const audioContextRef = useRef(null);
    const aiAudioAnalyserRef = useRef(null);
    const aiSilenceCheckIntervalRef = useRef(null);

    // 오디오 버퍼 관리 관련
    const audioChunksRef = useRef([]);
    const currentBlobUrlRef = useRef(null);
    const isBufferingRef = useRef(false);
    const bufferErrorCountRef = useRef(0);
    const useBufferingRef = useRef(true);

    // 상태 관리
    const [connected, setConnected] = useState(false);
    const [wsConnected, setWsConnected] = useState(false);
    const [sessionId, setSessionId] = useState(null);
    const [transcripts, setTranscripts] = useState([]);
    const [loading, setLoading] = useState(false);
    const [aiSpeaking, setAiSpeaking] = useState(false);
    const [userSpeaking, setUserSpeaking] = useState(false);
    const [reconnecting, setReconnecting] = useState(false);
    const [isInitialGreeting, setIsInitialGreeting] = useState(true);
    const [sttError, setSttError] = useState(null);
    const [connectionError, setConnectionError] = useState(null);

    const transcriptsRef = useRef(transcripts);

    // 컴포넌트 마운트 상태 추적
    const isMountedRef = useRef(true);

    // STT 결과 대기 중인지 추적
    const waitingForSTTRef = useRef(false);

    // 세션 복구 여부 추적
    const isResumingRef = useRef(false);

    // PTT 설정
    const PTT_MAX_DURATION = 30000;

    const MIN_USER_SPEECH_DURATION = 500;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const RECONNECT_DELAY = 2000;

    const {
        getExistingSession,
        startSession,
        resumeSession,
        completeSession,
        abandonSession,
        failSession,
        isSessionCompleted,
        isSessionInProgress,
        isSessionFailed,
        updateLastActivity,
    } = useSessionStore();

    // 이상한 STT 결과 필터링 함수
    const isInvalidSTTResult = (text) => {
        if (!text || text.trim().length === 0) return true;

        const trimmedText = text.trim();

        // 의미 없는 짧은 감탄사/소음 필터링
        const meaninglessPatterns = [
            /^엥\??$/i,
            /^에\??$/i,
            /^어\??$/i,
            /^음\??$/i,
            /^으음\??$/i,
            /^아\??$/i,
            /^어어\??$/i,
            /^으\??$/i,
            /^어음\??$/i,
            /^흠\??$/i,
        ];

        // 의미 있는 짧은 발화는 허용
        const meaningfulShortWords = [
            /^네$/i,
            /^예$/i,
            /^아니요?$/i,
            /^좋아$/i,
            /^싫어$/i,
            /^맞아$/i,
            /^틀려$/i,
            /^왜\??$/i,
            /^뭐\??$/i,
            /^언제\??$/i,
            /^어디\??$/i,
            /^누구\??$/i,
            /^어떻게\??$/i,
            /^야$/i,
        ];

        // 의미 있는 짧은 발화면 허용
        if (meaningfulShortWords.some(pattern => pattern.test(trimmedText))) {
            return false;
        }

        // 의미 없는 짧은 감탄사면 필터링
        if (meaninglessPatterns.some(pattern => pattern.test(trimmedText))) {
            return true;
        }

        // 유튜브/방송 관련 패턴들
        const invalidPatterns = [
            /MBC.*뉴스/i,
            /구독.*좋아요/i,
            /알림.*설정/i,
            /채널.*구독/i,
            /좋아요.*누르/i,
            /시청.*감사/i,
            /댓글.*남겨/i,
            /다음.*영상/i,
            /KBS.*SBS.*MBC/i,
            /유튜브.*채널/i,
            /라이브.*방송/i,
        ];

        // 패턴 매칭
        return invalidPatterns.some(pattern => pattern.test(text));
    };

    /**
     * 오디오 버퍼링 시작
     */
    const startBuffering = useCallback(() => {
        audioChunksRef.current = [];
        isBufferingRef.current = true;
        console.log('🎵 오디오 버퍼링 시작');
    }, []);

    /**
     * 오디오 청크 추가
     */
    const addAudioChunk = useCallback((base64Data) => {
        if (!useBufferingRef.current) return;

        try {
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            audioChunksRef.current.push(bytes.buffer);
            console.log(`📦 오디오 청크 추가 (총 ${audioChunksRef.current.length}개)`);
        } catch (error) {
            console.error('오디오 청크 디코딩 실패:', error);
            bufferErrorCountRef.current++;

            if (bufferErrorCountRef.current >= 3) {
                console.warn('버퍼링 에러 과다 - 기존 방식으로 전환');
                disableBuffering();
            }
        }
    }, []);

    /**
     * Blob URL 정리
     */
    const cleanupBlobUrl = useCallback(() => {
        if (currentBlobUrlRef.current) {
            URL.revokeObjectURL(currentBlobUrlRef.current);
            currentBlobUrlRef.current = null;
            console.log('🗑️ Blob URL 정리 완료');
        }
    }, []);

    /**
     * 재생 에러 처리
     */
    const handlePlaybackError = useCallback(() => {
        console.error('❌ 재생 에러 발생');
        bufferErrorCountRef.current++;

        cleanupBlobUrl();
        audioChunksRef.current = [];
        isBufferingRef.current = false;

        setAiSpeaking(false);
        setVadStatus('idle');

        if (bufferErrorCountRef.current >= 3) {
            console.warn('재생 에러 과다 - 기존 방식으로 전환');
            disableBuffering();
        }
    }, []);

    /**
     * 버퍼링 방식 비활성화 및 폴백
     */
    const disableBuffering = useCallback(() => {
        useBufferingRef.current = false;
        audioChunksRef.current = [];
        cleanupBlobUrl();

        // audio 태그를 remoteStream으로 전환
        if (audioTagRef.current && pcRef.current) {
            const receivers = pcRef.current.getReceivers();
            const audioReceiver = receivers.find(r => r.track && r.track.kind === 'audio');

            if (audioReceiver) {
                const remoteStream = new MediaStream([audioReceiver.track]);
                audioTagRef.current.srcObject = remoteStream;
                audioTagRef.current.autoplay = true;
                audioTagRef.current.play()
                    .catch(err => console.error('폴백 재생 실패:', err));
            }
        }

        console.log('⚠️ 기존 srcObject 방식으로 전환 완료');
    }, []);

    /**
     * Blob 생성 및 재생
     */
    const createAndPlayBlob = useCallback(() => {
        if (audioChunksRef.current.length === 0) {
            console.warn('⚠️ 재생할 오디오 청크 없음');
            setAiSpeaking(false);
            setVadStatus('idle');
            return;
        }

        try {
            cleanupBlobUrl();

            const blob = new Blob(audioChunksRef.current, { type: 'audio/pcm' });
            const blobUrl = URL.createObjectURL(blob);

            currentBlobUrlRef.current = blobUrl;

            if (audioTagRef.current) {
                audioTagRef.current.src = blobUrl;
                audioTagRef.current.play()
                    .then(() => console.log('▶️ Blob 오디오 재생 시작'))
                    .catch(err => {
                        console.error('Blob 재생 실패:', err);
                        handlePlaybackError();
                    });
            }

            audioChunksRef.current = [];
            isBufferingRef.current = false;

        } catch (error) {
            console.error('Blob 생성 실패:', error);
            bufferErrorCountRef.current++;
            handlePlaybackError();
        }
    }, [handlePlaybackError, cleanupBlobUrl]);

    /**
     * WebRTC + WebSocket 통합 연결
     */
    const initRealtimeConnection = useCallback(async () => {
        if (!isMountedRef.current) return;

        // 에러 카운트 초기화 (세션 재시작)
        bufferErrorCountRef.current = 0;

        // 1. 기존 세션 존재 여부 확인
        const existingSession = getExistingSession(scenarioId, userId);
        if (existingSession) {
            const status = existingSession.status;
            if (status === 'completed') {
                console.log('이미 완료된 시나리오입니다.');
                throw new Error('이미 완료된 시나리오입니다.');
            } else if (status === 'abandoned') {
                console.log('중단된 시나리오입니다. 새로 시작해주세요.');
                throw new Error('중단된 시나리오입니다. 새로 시작해주세요.');
            } else if (status === 'ongoing') {
                console.log('진행 중인 대화를 복구합니다.');
                // ongoing 상태는 세션 복구로 재시도 허용 - 계속 진행
            } else if (status === 'failed') {
                console.log('이전 연결이 실패했습니다. 다시 시도합니다.');
                // failed 상태는 재시도 허용 - 계속 진행
            }
        }

        setLoading(true);
        setIsInitialGreeting(true);

        try {
            let targetSessionId;
            isResumingRef.current = false; // 초기화

            // 2. 세션 생성 또는 복구
            if (existingSession && (existingSession.status === 'ongoing' || existingSession.status === 'failed')) {
                // 기존 세션이 있으면 백엔드 상태 확인
                console.log('기존 세션 상태 확인:', existingSession.sessionId);

                try {
                    const sessionCheckResponse = await apiClient.get(`/sessions/${existingSession.sessionId}`);
                    const backendStatus = sessionCheckResponse.data.data.status;

                    if (backendStatus === 'ONGOING') {
                        // 백엔드에서도 ongoing이면 세션 복구
                        console.log('백엔드 세션 복구 가능:', existingSession.sessionId);
                        targetSessionId = existingSession.sessionId;
                        isResumingRef.current = true;
                    } else {
                        // 백엔드에서 completed면 새 세션 생성
                        console.log('백엔드 세션 완료됨, 새 세션 생성');
                        const sessionResponse = await apiClient.post('/sessions', { scenarioId, userId });
                        if (!isMountedRef.current) return;
                        targetSessionId = sessionResponse.data.data.sessionId;
                    }
                } catch (error) {
                    // 세션 조회 실패 시 새 세션 생성
                    console.log('세션 조회 실패, 새 세션 생성:', error);
                    const sessionResponse = await apiClient.post('/sessions', { scenarioId, userId });
                    if (!isMountedRef.current) return;
                    targetSessionId = sessionResponse.data.data.sessionId;
                }
            } else {
                // 새 세션 생성
                console.log('새 세션 생성');
                const sessionResponse = await apiClient.post('/sessions', { scenarioId, userId });
                if (!isMountedRef.current) return;

                targetSessionId = sessionResponse.data.data.sessionId;
            }

            setSessionId(targetSessionId);

            // 3. Ephemeral Key 발급 (재개 시에도 새로 발급)
            console.log('🔑 Ephemeral Key 발급 요청 시작...', {
                sessionId: targetSessionId,
                model: "gpt-realtime"
            });

            const ephemeralResponse = await apiClient.post('/realtime/session', {
                sessionId: targetSessionId,
                model: "gpt-realtime",
                voice: "alloy",
                sttModel: "whisper-1",
                language: "ko"
            });

            if (!ephemeralResponse.data.success) {
                const errorMsg = ephemeralResponse.data.message || "Ephemeral Key 발급 실패";
                console.error('❌ Ephemeral Key 발급 실패:', errorMsg);
                throw new Error(errorMsg);
            }

            const ephemeralKey = ephemeralResponse.data.data.client_secret.value;
            console.log('✅ Ephemeral Key 발급 완료');
            console.log(`🎯 GPT 세션 ID: ${ephemeralResponse.data.data.id}`);

            if (!isMountedRef.current) return;

            // 4. WebSocket 연결 (복구 여부 전달)
            await initWebSocket(targetSessionId, isResumingRef.current);
            if (!isMountedRef.current) return;

            // 5. WebRTC 연결
            await initWebRtc(ephemeralKey, targetSessionId, scenarioId, userId);

            // 6. WebRTC 연결 성공 후 세션 상태를 ongoing로 설정
            startSession(targetSessionId, scenarioId, userId);
            console.log('세션 시작됨:', targetSessionId);

        } catch (err) {
            console.error("Realtime 연결 실패:", err);
            if (isMountedRef.current) {
                // 연결 실패 시 세션을 failed 상태로 변경
                let errorMessage = err.message;

                // 마이크 권한 관련 에러 메시지 개선
                if (err.message.includes('마이크') || err.message.includes('getUserMedia') || err.message.includes('Permission denied')) {
                    errorMessage = '마이크 권한이 필요합니다. 브라우저에서 마이크 권한을 허용해주세요.';
                }

                try {
                    failSession(scenarioId, userId, errorMessage);
                } catch (sessionError) {
                    console.error('failSession 호출 실패:', sessionError);
                }
                await cleanupConnection();
                setLoading(false);
            }
            throw err;
        } finally {
            if (isMountedRef.current) {
                setLoading(false);
            }
        }
    }, [userId, scenarioId, getExistingSession, startSession, failSession])

    /**
     * webSocket 연결 초기화
     */
    const initWebSocket = useCallback((sessionId, isReconnection = false) => {
        return new Promise((resolve, reject) => {
            if (!isMountedRef.current) {
                reject(new Error('Component unmounted'));
                return;
            }

            if (wsRef.current?.readyState === WebSocket.OPEN) {
                console.log("webSocket 이미 연결 됨");
                resolve();
                return;
            }

            const baseWsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:9090/ws';
            const wsUrl = `${baseWsUrl}/transcript/${sessionId}`;

            console.log('webSocket 연결 시도: ', wsUrl);
            wsRef.current = new WebSocket(wsUrl);

            const timeout = setTimeout(() => {
                if (wsRef.current) {
                    wsRef.current.close();
                    reject(new Error('WebSocket 연결 타임아웃'));
                }
            }, 10000); // 10초 타임아웃

            wsRef.current.onopen = () => {
                clearTimeout(timeout);
                if (!isMountedRef.current) {
                    wsRef.current.close();
                    reject(new Error('Component unmounted'));
                    return;
                }

                console.log("webSocket 연결 성공");
                setWsConnected(true);
                reconnectAttemptsRef.current = 0;

                if (isReconnection) {
                    console.log("재연결 시도 - 대화 내역 복구 요청");
                    wsRef.current.send(JSON.stringify({
                        type: "SESSION_RECONNECT",
                        sessionId: sessionId,
                        timestamp: new Date().toISOString()
                    }));
                    setReconnecting(false);
                } else {
                    wsRef.current.send(JSON.stringify({
                        type: "SESSION_INIT",
                        sessionId: sessionId,
                        scenarioId: scenarioId,
                        timestamp: new Date().toISOString()
                    }));
                }
                resolve();
            };

            wsRef.current.onmessage = (e) => {
                if (!isMountedRef.current) return;
                try {
                    const message = JSON.parse(e.data);
                    handleWebSocketMessage(message);
                } catch (err) {
                    console.log("webSocket 메세지 파싱 실패: ", err);
                }
            };

            wsRef.current.onerror = (err) => {
                clearTimeout(timeout);
                console.error("webSocket 에러:", err);
                reject(err);
            }

            wsRef.current.onclose = (e) => {
                clearTimeout(timeout);
                console.log("webSocket 종료: ", e.code, e.reason);
                if (isMountedRef.current) {
                    setWsConnected(false);
                }

                // 정상 종료가 아니고, 재연결 시도 횟수가 5회 미만일 때만 재연결
                if (e.code !== 1000 && isMountedRef.current) {
                    // attemptReconnect 내부에서 횟수 체크 및 증가 처리
                    attemptReconnect(sessionId);
                }
            };
        });
    }, [scenarioId]);

    /**
     * webSocket 메세지 처리
     */
    const handleWebSocketMessage = useCallback((message) => {
        console.log("webSocket 메세지 수신: ", message.type);
        switch (message.type) {
            case 'SESSION_RECOVERY':
                handleSessionRecovery(message);
                break;
            case 'user.transcript':
                console.log("사용자 발화 저장 완료: ", message.text);
                break;
            case 'ai.transcript':
                console.log("AI 발화 저장 완료: ", message.text);
                break;
            case 'ERROR':
                console.log('webSocket 에러 발생: ', message.message);
                break;
            default:
                console.log('알 수 없는 메세지 타입: ', message.type);
        }
    }, []);

    /**
     * 세션 재연결 및 대화 내역 복구
     */
    const handleSessionRecovery = useCallback((message) => {
        console.log("세션 복구 메세지: ", message);

        if (!message.success) {
            console.log("세션 복구 실패: ", message.errorMessage);
            return;
        }

        let recovered = []; // ← 빈 배열로 초기화

        if (message.transcripts && message.transcripts.length > 0) {
            recovered = message.transcripts.map(item => ({
                speaker: item.speaker.toLowerCase(),
                text: item.content,
                timestamp: item.timestamp
            }));
        } else {
            console.log("복구할 대화 내역 없음");
            return;
        }

        setTranscripts(recovered);
        console.log(`대화 내역 복구 완료: ${recovered.length} 개 메세지`);

        // 복구된 대화가 있으면 초기 인사 건너뛰기
        if (recovered.length > 0) {
            setIsInitialGreeting(false);
            console.log("세션 복구: 초기 인사 건너뛰기 설정");
        }

        let isContextSent = false;
        let timeoutId = null;

        // DataChannel 상태 체크 후 컨텍스트 전송
        const sendContextWhenReady = () => {
            // 컴포넌트 언마운트 체크
            if (!isMountedRef.current) {
                console.log("컴포넌트 언마운트됨 - DataChannel 대기 중단");
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                return;
            }

            if (isContextSent) {
                console.log("이미 컨텍스트 전송됨 - 중단");
                return;
            }

            if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
                console.log("DataChannel 대기 중...");
                timeoutId = setTimeout(sendContextWhenReady, 500);
                return;
            }

            isContextSent = true;
            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            // 사용자 발화가 있는 경우만 컨텍스트 전송
            const hasUserText = recovered.some(item => item.speaker === 'user');
            if (hasUserText) {
                const contextSent = sendRecoveryContext();
                if (contextSent) {
                    console.log("복구된 전체 대화 AI에게 전송완료");

                    // 마지막 발화자 체크 로직
                    const lastMessage = recovered[recovered.length - 1];

                    if (lastMessage && lastMessage.speaker === 'user') {
                        // 사용자가 마지막에 말했으면 → AI가 대답해야 함
                        dataChannelRef.current.send(JSON.stringify({
                            type: "conversation.item.create",
                            item: {
                                type: "message",
                                role: "system",
                                content: [{
                                    type: "input_text",
                                    text: `⚠️ 중요: 사용자가 "${lastMessage.text}"라고 마지막에 말했습니다. 새로운 인사 없이 바로 이 발화에 대해 자연스럽게 응답하세요.`
                                }]
                            }
                        }));

                        // AI 응답 요청
                        setTimeout(() => {
                            dataChannelRef.current.send(JSON.stringify({
                                type: 'response.create',
                                response: { modalities: ["audio", "text"] }
                            }));
                        }, 300);

                    } else if (lastMessage && lastMessage.speaker === 'ai') {
                        // AI가 마지막에 말했으면 → 사용자 차례 (대기)
                        dataChannelRef.current.send(JSON.stringify({
                            type: "conversation.item.create",
                            item: {
                                type: "message",
                                role: "system",
                                content: [{
                                    type: "input_text",
                                    text: "위 대화를 이어서 진행하세요. 사용자의 다음 발화를 기다리세요."
                                }]
                            }
                        }));
                        // response.create 호출 안 함 (사용자 차례)
                    }
                }
            }
        };

        sendContextWhenReady();
    }, []);

    /**
     * webSocket 재연결 시도
     */
    const attemptReconnect = useCallback(async (sessionId) => {
        reconnectAttemptsRef.current++;

        // 재연결 시도 5회 초과 시 세션 실패 처리
        if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
            console.error(`❌ 재연결 실패: ${MAX_RECONNECT_ATTEMPTS}회 초과`);
            failSession(scenarioId, userId, 'WebSocket 재연결 실패');
            await cleanupConnection();
            setLoading(false);
            setReconnecting(false);

            // 페이지 새로고침하여 차단 화면 표시
            setTimeout(() => {
                window.location.reload();
            }, 1000);
            return;
        }

        const delay = RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef.current - 1);

        console.log(`재연결 시도 ${reconnectAttemptsRef.current} / ${MAX_RECONNECT_ATTEMPTS} (${delay}ms 후)`);
        setReconnecting(true);

        reconnectTimeoutRef.current = setTimeout(() => {
            initWebSocket(sessionId, true);
        }, delay);

    }, [initWebSocket, failSession, scenarioId, userId]);

    /**
     * 전체 세션 재연결 (WebRTC + WebSocket)
     */
    const attemptFullReconnect = useCallback((reason) => {
        console.log(`🔄 전체 재연결 시도: ${reason}`);

        // 에러 상태 설정 (DialoguePage에서 감지)
        setConnectionError({
            type: reason.includes('마이크') ? 'microphone' : 'webrtc',
            message: reason.includes('마이크')
                ? '마이크 연결이 끊어졌습니다.\n마이크를 확인하고 다시 시도해주세요.'
                : '연결이 끊어졌습니다.\n다시 시도해주세요.',
            reason: reason
        });

        // WebRTC 연결 끊김은 초기 연결 문제일 수 있으므로 failed 처리
        // 마이크 연결 끊김은 ongoing 유지
        if (reason.includes('WebRTC') || reason.includes('초기')) {
            failSession(scenarioId, userId, reason);
        }
    }, [failSession, scenarioId, userId]);

    /**
     * 백엔드로 대화 내용 전송
     */
    const sendTranscript = useCallback((speaker, text) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            console.log("webSocket 연결 안됨 - 대화 내용 전송 실패");
            return;
        }

        const timeInfo = speaker === 'user' ? lastUserSpeakingTimeRef.current : lastAiSpeakingTimeRef.current;

        wsRef.current.send(JSON.stringify({
            type: "TRANSCRIPT",
            speaker: speaker.toUpperCase(),
            text: text,
            startTimeMs: timeInfo?.startMs || Date.now(),
            endTimeMs: timeInfo?.endMs || Date.now(),
            timestamp: new Date().toISOString()
        }));

        console.log(`대화 내용 전송: ${speaker} - ${text.substring(0, 50)}...`);
    }, []);

    /**
     * AI 음성 침묵 감지
     */
    const startAiVadCheck = useCallback(() => {
        if (!aiAudioAnalyserRef.current) {
            console.log("⚠️ VAD 시작 실패: analyser 없음");
            return;
        }

        // 이미 실행 중이면 중복 방지
        if (aiSilenceCheckIntervalRef.current) {
            console.log("⚠️ VAD 이미 실행 중");
            return;
        }

        const analyser = aiAudioAnalyserRef.current;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let silenceCount = 0;

        // 모든 대화에서 더 관대한 설정 (음성 끊김 방지)
        const SILENCE_THRESHOLD = isInitialGreeting ? 2 : 3;  // 전체적으로 덜 민감하게
        const SILENCE_CHECKS = isInitialGreeting ? 15 : 10;   // 더 오래 기다리기 (첫인사 3초, 일반 2초)

        console.log(`🎤 VAD 설정 - 임계값: ${SILENCE_THRESHOLD}, 체크횟수: ${SILENCE_CHECKS} (첫인사: ${isInitialGreeting})`);

        const checkSilence = () => {
            // aiSpeaking 체크 제거! 무조건 끝까지 분석

            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b) / dataArray.length;

            if (average < SILENCE_THRESHOLD) {
                silenceCount++;
                console.log(`🔇 침묵 ${silenceCount}/${SILENCE_CHECKS} (레벨: ${average.toFixed(1)})`);

                if (silenceCount >= SILENCE_CHECKS) {
                    console.log("✅ AI 발화 종료 (침묵 감지)");
                    setAiSpeaking(false);
                    setVadStatus('idle');
                    clearInterval(aiSilenceCheckIntervalRef.current);
                    aiSilenceCheckIntervalRef.current = null;
                }
            } else {
                if (silenceCount > 0) {
                    console.log(`🔊 음성 재개 (레벨: ${average.toFixed(1)})`);
                }
                silenceCount = 0;
            }
        };

        aiSilenceCheckIntervalRef.current = setInterval(checkSilence, 200);
        console.log("🎤 AI VAD 체크 시작");

    }, [isInitialGreeting]);



    /**
     * webRtc 연결 초기화
     */
    const initWebRtc = useCallback(async (ephemeralKey, sessionId, scenarioId, userId) => {
        if (!isMountedRef.current) {
            throw new Error('Component unmounted');
        }

        // 1. peerConnection 설정
        pcRef.current = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                {
                    urls: "turn:openrelay.metered.ca:80",
                    username: "openrelayproject",
                    credential: "openrelayproject"
                }
            ]
        });

        // 2. DataChannel 설정
        dataChannelRef.current = pcRef.current.createDataChannel('oai-events');

        dataChannelRef.current.onopen = () => {
            if (!isMountedRef.current) return;

            console.log("✅ Data Channel 열림");
            setConnected(true);

            // isResumingRef로 세션 복구 여부 확인
            if (isResumingRef.current) {
                console.log("🔄 세션 복구 - 첫 인사 건너뛰기");
                setIsInitialGreeting(false);
            } else {
                console.log("🎙️ 새 세션 - 첫 인사 모드 설정");
                setIsInitialGreeting(true);

                // AI가 먼저 인사하도록 response.create 전송
                if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
                    dataChannelRef.current.send(JSON.stringify({
                        type: "response.create",
                        response: {
                            modalities: ["audio", "text"]
                        }
                    }));
                }
            }
        };

        dataChannelRef.current.onmessage = (event) => {
            if (!isMountedRef.current) return;

            console.log("메시지 받음! 원본:", event.data);

            try {
                const data = JSON.parse(event.data);

                // 오디오 청크 수신
                if (data.type === "response.audio.delta") {
                    if (useBufferingRef.current && data.delta) {
                        addAudioChunk(data.delta);
                    }
                }

                // 오디오 전송 완료
                if (data.type === "response.audio.done") {
                    if (useBufferingRef.current) {
                        console.log('🎵 오디오 전송 완료 - Blob 생성 및 재생');
                        createAndPlayBlob();
                    }
                }

                // AI 발화 시작
                if (data.type === "output_audio_buffer.started") {
                    console.log("🤖 AI 발화 시작");
                    if (isMountedRef.current) {
                        setAiSpeaking(true);
                        aiSpeakingStartRef.current = Date.now();

                        // 버퍼링 시작
                        if (useBufferingRef.current) {
                            startBuffering();
                        }

                        // 첫 인사가 아닐 때만 발화 중 VAD 시작 (더 빠른 반응) - 버퍼링 방식에서는 사용 안 함
                        if (!isInitialGreeting && !useBufferingRef.current) {
                            setTimeout(() => {
                                if (isMountedRef.current && aiSpeaking) {
                                    startAiVadCheck();
                                }
                            }, 2000);
                        } else {
                            console.log("🎙️ 첫 인사 중 또는 버퍼링 모드 - VAD 시작 안 함");
                        }
                    }
                }

                // AI 발화 종료 - VAD 시작 (버퍼링 방식에서는 사용 안 함)
                if (data.type === "output_audio_buffer.stopped") {
                    if (!useBufferingRef.current) {
                        console.log("🔊 오디오 버퍼 정지 - VAD 시작 (기존 방식)");
                        if (isMountedRef.current) {
                            // 모든 대화에서 충분히 기다리기 (음성 끊김 방지)
                            const vadDelay = isInitialGreeting ? 2000 : 1200;
                            console.log(`⏰ VAD 시작 지연: ${vadDelay}ms (첫인사: ${isInitialGreeting})`);

                            setTimeout(() => {
                                if (isMountedRef.current) {
                                    startAiVadCheck();
                                }
                            }, vadDelay);
                        }
                    } else {
                        console.log("🔊 오디오 버퍼 정지 - 버퍼링 모드에서는 무시");
                    }
                }

                // AI 텍스트 응답
                if (data.type === "response.audio_transcript.done") {
                    if (!isMountedRef.current) return;

                    // ✅ 최초 인사 완료
                    setIsInitialGreeting(false);

                    const transcript = {
                        speaker: 'ai',
                        text: data.transcript,
                        timestamp: aiSpeakingStartRef.current
                            ? new Date(aiSpeakingStartRef.current).toISOString()
                            : new Date().toISOString()
                    }

                    setTranscripts(prev => {
                        const filtered = prev.filter(t => !t.isTemp);
                        const updated = [...filtered, transcript];

                        return updated.sort((a, b) => {
                            const aTime = new Date(a.timestamp).getTime();
                            const bTime = new Date(b.timestamp).getTime();
                            const timeDiff = aTime - bTime;
                            if (Math.abs(timeDiff) < 1000) {
                                if (a.speaker === 'user') return -1;
                                if (b.speaker === 'user') return 1;
                            }
                            return timeDiff;
                        });
                    });

                    sendTranscript('ai', data.transcript);
                }

                // 사용자 STT 완료
                if (data.type === 'conversation.item.input_audio_transcription.completed') {
                    if (!isMountedRef.current) return;

                    // 이상한 STT 결과 필터링
                    if (isInvalidSTTResult(data.transcript)) {
                        console.log(`🚫 이상한 STT 결과 필터링: "${data.transcript}"`);

                        // 임시 메시지만 제거하고 무시
                        setTranscripts(prev => prev.filter(t => !t.isTemp));

                        // 사용자에게 STT 에러 피드백 제공
                        const errorMessage = !data.transcript || data.transcript.trim().length === 0
                            ? "음성이 인식되지 않았습니다. 다시 시도해 주세요."
                            : "음성 인식에 문제가 있었습니다. 다시 말씀해 주세요.";

                        setSttError(errorMessage);

                        // 3초 후 에러 메시지 자동 제거
                        setTimeout(() => {
                            if (isMountedRef.current) {
                                setSttError(null);
                            }
                        }, 3000);

                        // 빈 문자열인 경우 대기 상태 유지 (실제 STT 결과 기다림)
                        if (!data.transcript || data.transcript.trim().length === 0) {
                            console.log("🔄 빈 STT 결과 - 실제 결과 대기 중...");
                            // waitingForSTTRef 상태 유지 (해제하지 않음)
                        } else {
                            // 의미없는 감탄사 등은 대기 상태 해제
                            if (waitingForSTTRef.current) {
                                waitingForSTTRef.current = false;
                                console.log("🚫 필터링으로 인한 응답 요청 중단 - 사용자 피드백 제공");
                                setVadStatus('idle');
                            }
                        }
                        return;
                    }

                    const transcript = {
                        speaker: 'user',
                        text: data.transcript,
                        timestamp: userSpeakingStartRef.current
                            ? new Date(userSpeakingStartRef.current).toISOString()
                            : new Date().toISOString()
                    }

                    setTranscripts(prev => {
                        const filtered = prev.filter(t => !t.isTemp);
                        const updated = [...filtered, transcript];

                        return updated.sort((a, b) => {
                            const aTime = new Date(a.timestamp).getTime();
                            const bTime = new Date(b.timestamp).getTime();
                            const timeDiff = aTime - bTime;
                            if (Math.abs(timeDiff) < 1000) {
                                if (a.speaker === 'user') return -1;
                                if (b.speaker === 'user') return 1;
                            }
                            return timeDiff;
                        });
                    });

                    sendTranscript('user', data.transcript);

                    // 활동 시간 업데이트
                    updateLastActivity(scenarioId, userId);

                    // STT 결과가 도착했으므로 응답 요청
                    if (waitingForSTTRef.current) {
                        waitingForSTTRef.current = false;
                        console.log("✅ STT 결과 도착 - 응답 요청 시작");

                        // 잠시 대기 후 컨텍스트 전송 및 응답 요청
                        setTimeout(() => {
                            const contextSent = sendCurrentContext();

                            if (contextSent && dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
                                dataChannelRef.current.send(JSON.stringify({
                                    type: 'response.create',
                                    response: { modalities: ["audio", "text"] }
                                }));
                                console.log("✅ AI 응답 요청 전송 (STT 기반)");
                            } else {
                                console.log("🚫 컨텍스트 전송 실패");
                                setVadStatus('idle');
                            }
                        }, 100);
                    }
                }
            } catch (err) {
                console.error("이벤트 파싱 실패:", err);
            }
        };

        dataChannelRef.current.onerror = (err) => console.error("DataChannel 에러:", err);
        dataChannelRef.current.onclose = () => console.log("DataChannel 닫힘");

        // 3. 마이크 스트림 설정
        try {
            const localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 16000,
                    channelCount: 1
                }
            });

            if (!isMountedRef.current) {
                localStream.getTracks().forEach(track => track.stop());
                throw new Error('Component unmounted');
            }

            localStreamRef.current = localStream;

            localStream.getTracks().forEach(track => {
                track.enabled = false;
                pcRef.current.addTrack(track, localStream);
                console.log("마이크 초기 상태: 비활성화");

                // 미디어 트랙 상태 모니터링
                track.onended = () => {
                    console.log("🎤 마이크 트랙 종료됨");
                    if (isMountedRef.current) {
                        console.log('마이크 연결이 끊어졌습니다. 재연결을 시도합니다...');

                        // 마이크 재연결 시도
                        attemptFullReconnect('마이크 연결 끊김');
                    }
                };

                track.onmute = () => {
                    console.log("🔇 마이크 음소거됨");
                };

                track.onunmute = () => {
                    console.log("🎤 마이크 음소거 해제됨");
                };
            });


        } catch (err) {
            console.error("마이크 접근 실패:", err);
            throw new Error('마이크 접근 권한이 필요합니다.');
        }

        // 4. AI 오디오 스트림 설정 (핵심!)
        pcRef.current.ontrack = (event) => {
            console.log("🎵 ontrack 이벤트!");

            if (!event.streams || event.streams.length === 0) return;
            const remoteStream = event.streams[0];
            if (remoteStream.getAudioTracks().length === 0) return;

            // 1. audio 태그로 재생 (필수!)
            if (audioTagRef.current && isMountedRef.current) {
                audioTagRef.current.srcObject = remoteStream;
                audioTagRef.current.autoplay = true;
                audioTagRef.current.play()
                    .then(() => console.log("오디오 재생 시작!"))
                    .catch(err => console.error("재생 실패:", err));
            }

            //  2. AudioContext로 분석 (VAD용)
            try {
                if (!audioContextRef.current && isMountedRef.current) {
                    const AudioContextClass = window.AudioContext || window['webkitAudioContext'];
                    audioContextRef.current = new AudioContextClass();
                    console.log("AudioContext 생성");
                }

                if (audioContextRef.current && isMountedRef.current) {
                    const source = audioContextRef.current.createMediaStreamSource(remoteStream);
                    const analyser = audioContextRef.current.createAnalyser();
                    analyser.fftSize = 2048;
                    analyser.smoothingTimeConstant = 0.8;

                    source.connect(analyser);

                    aiAudioAnalyserRef.current = analyser;
                    console.log("AI VAD 분석기 초기화 완료!");
                }
            } catch (err) {
                console.error("AudioContext 설정 실패:", err);
            }
        };

        // 5. 연결 상태 모니터링
        pcRef.current.oniceconnectionstatechange = () => {
            if (!isMountedRef.current) return;
            console.log("ICE 상태:", pcRef.current.iceConnectionState);
        };

        pcRef.current.onconnectionstatechange = () => {
            if (!isMountedRef.current) return;
            console.log("연결 상태:", pcRef.current.connectionState);

            if (pcRef.current.connectionState === 'disconnected') {
                console.log("🔌 WebRTC 연결 끊김 - 재연결 시도");
                // 연결 끊김 시 사용자에게 알림
                console.log('연결이 끊어졌습니다. 재연결을 시도합니다...');

                // WebRTC 재연결 시도
                attemptFullReconnect('WebRTC 연결 끊김');

            } else if (pcRef.current.connectionState === 'failed') {
                console.log("❌ WebRTC 연결 완전 실패");
                console.log('연결에 실패했습니다. 페이지를 새로고침해주세요.');
                failSession(scenarioId, userId, 'WebRTC 연결 실패');

            } else if (pcRef.current.connectionState === 'connected') {
                console.log("✅ WebRTC 연결 성공");

            } else if (pcRef.current.connectionState === 'connecting') {
                console.log("🔄 WebRTC 연결 중...");
            }
        };

        // 6. SDP Offer/Answer
        const offer = await pcRef.current.createOffer();
        await pcRef.current.setLocalDescription(offer);

        const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=gpt-realtime`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${ephemeralKey}`,
                "Content-Type": "application/sdp"
            },
            body: offer.sdp
        });

        if (!isMountedRef.current) {
            throw new Error('Component unmounted');
        }

        if (!sdpResponse.ok) {
            const errorText = await sdpResponse.text();
            throw new Error(`GPT SDP 교환 실패 (${sdpResponse.status}): ${errorText}`);
        }

        const answerSdp = await sdpResponse.text();
        await pcRef.current.setRemoteDescription({ type: "answer", sdp: answerSdp });
        console.log("WebRtc 연결됨");
    }, [failSession]);

    /**
     * 마이크 트랙 제어
     */
    const enableMicroPhone = useCallback(() => {
        if (!localStreamRef.current) return;
        localStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = true;
        })
        console.log("마이크 활성화");
    }, []);

    const disableMicroPhone = useCallback(() => {
        if (!localStreamRef.current) return;
        localStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = false;
        })
        console.log("마이크 비활성화");
    }, []);

    /**
     * PTT 시작
     */
    const startPushToTalk = useCallback(() => {
        if (!connected || aiSpeaking || isInitialGreeting) {
            console.log("PTT 시작 불가: 미연결 또는 AI 발화 중 또는 최초 인사 중");
            return;
        }

        console.log("🎤 PTT 시작");

        // 발화 시작 시간 기록
        userSpeakingStartRef.current = Date.now();

        enableMicroPhone();
        setIsPttActive(true);
        setUserSpeaking(true);
        setVadStatus('listening');

        pttTimerRef.current = setTimeout(() => {
            console.log("⏰ PTT 30초 타임아웃");
            stopPushToTalk('timeout');
        }, PTT_MAX_DURATION);
    }, [connected, aiSpeaking, isInitialGreeting, enableMicroPhone]);

    /**
     * PTT 종료
     */
    const stopPushToTalk = useCallback((reason = 'manual') => {
        if (!isPttActive) {
            console.log("PTT 이미 비활성화");
            return;
        }

        console.log(`🛑 PTT 종료: ${reason}`);

        if (pttTimerRef.current) {
            clearTimeout(pttTimerRef.current);
            pttTimerRef.current = null;
        }

        disableMicroPhone();
        setIsPttActive(false);
        setUserSpeaking(false);
        setVadStatus('processing');

        // 발화 길이 먼저 확인
        const startMs = userSpeakingStartRef.current;
        const duration = startMs ? Date.now() - startMs : 0;

        if (duration < MIN_USER_SPEECH_DURATION) {
            console.log(`🚫 짧은 발화: ${duration}ms - 전체 플로우 중단`);
            setVadStatus('idle');
            return; // 무음이면 전체 플로우 중단
        }

        // 1. 오디오 커밋 (사용자 음성 처리)
        commitAudioBuffer(reason);

        // 2. STT 결과 대기 상태로 설정
        waitingForSTTRef.current = true;
        console.log("⏳ STT 결과 대기 중...");

    }, [isPttActive, disableMicroPhone]);

    /**
     * 오디오 버퍼 전송
     */
    const commitAudioBuffer = useCallback((source = 'unknown') => {
        console.log(`📤 오디오 처리 시작: ${source}`);

        if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
            console.log("DataChannel 닫힘");
            setVadStatus('idle');
            return;
        }

        try {
            setTranscripts(prev => [...prev, {
                speaker: 'user',
                text: '처리 중...',
                timestamp: userSpeakingStartRef.current
                    ? new Date(userSpeakingStartRef.current).toISOString()
                    : new Date().toISOString(),
                isTemp: true
            }]);

            dataChannelRef.current.send(JSON.stringify({
                type: 'input_audio_buffer.commit'
            }));

            console.log("✅ 오디오 커밋 완료");

        } catch (err) {
            console.log("❌ 오디오 전송 실패: ", err);
            setVadStatus('idle');
        }

    }, []);

    /**
     * 재연결 시 AI에게 전체 컨텍스트 제공 (빈 오디오 포함)
     */
    const sendRecoveryContext = useCallback(() => {

        const currentTranscripts = transcriptsRef.current?.filter(t => !t.isTemp) || [];

        // 1. 컨텍스트 전송 (텍스트 + 빈 오디오)
        currentTranscripts.forEach((transcript, index) => {
            // 사용자 메시지에는 빈 오디오 추가 (맥락 이해 향상)
            const content = transcript.speaker === 'user'
                ? [
                    { type: "input_text", text: transcript.text },
                    { type: "input_audio", audio: "" }
                ]
                : [
                    { type: "input_text", text: transcript.text }
                ];

            dataChannelRef.current.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                    id: `recovery_${Date.now()}_${index}`,
                    type: "message",
                    role: transcript.speaker === 'user' ? 'user' : 'assistant',
                    content: content
                }
            }));
        });

        // 2. 세션 복구 지시
        dataChannelRef.current.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
                id: `session_recovery_${Date.now()}`,
                type: "message",
                role: "system",
                content: [{
                    type: "input_text",
                    text: "🚨 EMERGENCY PROTOCOL: 이것은 세션 복구입니다. 위 대화는 연결 끊김 전의 실제 대화입니다. 시스템 프롬프트의 '첫 발화 생성' 지시를 완전히 무시하고, 마지막 대화 상황에서 자연스럽게 이어가세요. 절대 '안녕하세요' 같은 새로운 인사를 하지 마세요."
                }]
            }
        }));

        console.log(`세션 복구: 전체 ${currentTranscripts.length}개 대화 컨텍스트 전송 (빈 오디오 포함) + 인사 금지 지시`);
        return true;

    }, []);

    /**
     * 사용자 발화 토글
     */
    const handleUserToggle = useCallback(() => {
        if (isPttActive) {
            stopPushToTalk('manual');
        } else {
            startPushToTalk();
        }
    }, [isPttActive, startPushToTalk, stopPushToTalk]);

    /**
     * 대화 컨텍스트 전송
     */
    const sendCurrentContext = useCallback(() => {

        if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
            console.log("DataChannel 아직 열리지 않음");
            return false;
        }

        const currentTranscripts = transcriptsRef.current?.filter(t => !t.isTemp) || [];

        if (currentTranscripts.length === 0) {
            console.log("🚫 보낼 컨텍스트 없음 - 응답 요청 중단");
            return false;
        }

        // 컨텍스트가 너무 많으면 최근 것만 전송 (역할 혼동 방지)
        const recentTranscripts = currentTranscripts.slice(-2); // 최근 2개만으로 더 제한
        console.log(`[컨텍스트 제한] 전체 ${currentTranscripts.length}개 중 최근 ${recentTranscripts.length}개만 전송`);

        // 역할 반전 방지를 위한 추가 체크
        if (recentTranscripts.length > 0) {
            console.log("[역할 체크] 최근 대화:", recentTranscripts.map(t => `${t.speaker}: ${t.text.substring(0, 20)}...`));
        }

        try {
            // 사용자의 마지막 발화만 전송 (역할 혼동 최소화)
            const lastUserMessage = recentTranscripts.filter(t => t.speaker === 'user').slice(-1)[0];

            if (lastUserMessage) {
                dataChannelRef.current.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                        id: `user_msg_${Date.now()}`,
                        type: "message",
                        role: "user",
                        content: [{
                            type: "input_text",
                            text: lastUserMessage.text
                        }]
                    }
                }));
                console.log(`[컨텍스트 전송] 사용자 마지막 메시지만 전송: "${lastUserMessage.text.substring(0, 30)}..."`);
                return true;
            } else {
                console.log("🚫 전송할 사용자 메시지 없음 - 응답 요청 중단");
                return false;
            }
        } catch (err) {
            console.error("컨텍스트 전송 실패:", err);
            return false;
        }
    }, []);

    /**
     * 세션 종료
     */
    const handleEndSession = async (isCompleted = true) => {
        if (loading) return;
        setLoading(true);
        try {
            if (isPttActive) {
                setIsPttActive(false);
            }

            if (!sessionId) {
                cleanupConnection();
                return;
            }

            // 백엔드에 세션 완료 알림
            await apiClient.put(`sessions/${sessionId}/complete`, { sessionId });

            // zustand에서 세션 상태 업데이트
            if (isCompleted) {
                completeSession(scenarioId, userId);
                console.log("세션 완료 처리됨");
            } else {
                abandonSession(scenarioId, userId);
                console.log("세션 중단 처리됨");
            }

            cleanupConnection();

        } catch (err) {
            console.error("세션 종료 실패:", err);
            throw err
        } finally {
            cleanupConnection();
            setLoading(false);
        }
    };

    /**
     * 연결 정리
     */
    const cleanupConnection = useCallback(async () => {
        // 컴포넌트 언마운트 플래그 설정 (모든 setTimeout 중단)
        isMountedRef.current = false;

        // 오디오 버퍼 정리
        cleanupBlobUrl();
        audioChunksRef.current = [];
        isBufferingRef.current = false;

        // AI VAD 정리
        if (aiSilenceCheckIntervalRef.current) {
            clearInterval(aiSilenceCheckIntervalRef.current);
            aiSilenceCheckIntervalRef.current = null;
        }

        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }

        aiAudioAnalyserRef.current = null;

        // PTT 타이머 정리
        if (pttTimerRef.current) {
            clearTimeout(pttTimerRef.current);
            pttTimerRef.current = null;
        }

        // WebRTC 정리
        if (pcRef.current) {
            pcRef.current.close();
            pcRef.current = null;
        }
        if (dataChannelRef.current) {
            dataChannelRef.current.close();
            dataChannelRef.current = null;
        }
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
        }

        // WebSocket 정리
        if (wsRef.current) {
            wsRef.current.close(1000, 'normal_closure');
            wsRef.current = null;
        }

        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        // 상태 초기화
        setConnected(false);
        setWsConnected(false);
        setSessionId(null);
        setTranscripts([]);
        setAiSpeaking(false);
        setUserSpeaking(false);
        setReconnecting(false);
        setIsPttActive(false);
        setVadStatus('idle');
        setIsInitialGreeting(true); // ✅ 추가
        reconnectAttemptsRef.current = 0;

        console.log("🧹 연결 정리 완료");

    }, []);

    // 컴포넌트 언마운트 시 정리
    useEffect(() => {
        isMountedRef.current = true;

        return () => {
            console.log("컴포넌트 언마운트 - 정리 시작");
            isMountedRef.current = false;
            cleanupConnection();
        };
    }, [cleanupConnection]);

    // 사용자 발화 시간 측정
    useEffect(() => {
        if (userSpeaking) {
            userSpeakingStartRef.current = Date.now();
            console.log("👤 사용자 발화 시작");
        } else if (userSpeakingStartRef.current) {
            const startMs = userSpeakingStartRef.current;
            const endMs = Date.now();
            const duration = endMs - startMs;

            console.log(`👤 사용자 발화 종료: ${(duration / 1000).toFixed(1)}초`);

            lastUserSpeakingTimeRef.current = {
                startMs, endMs, duration
            }

            userSpeakingStartRef.current = null;
        }
    }, [userSpeaking]);

    // AI 발화 시간 측정
    useEffect(() => {
        if (aiSpeaking) {
            aiSpeakingStartRef.current = Date.now();
            console.log("🤖 AI 발화 시작");
        } else if (aiSpeakingStartRef.current) {
            const startMs = aiSpeakingStartRef.current;
            const endMs = Date.now();
            const duration = endMs - startMs;

            console.log(`🤖 AI 발화 종료: ${(duration / 1000).toFixed(1)}초`);

            lastAiSpeakingTimeRef.current = {
                startMs, endMs, duration
            }

            aiSpeakingStartRef.current = null;
        }
    }, [aiSpeaking]);

    useEffect(() => {
        transcriptsRef.current = transcripts;
    }, [transcripts]);

    // Audio 태그 이벤트 리스너 설정
    useEffect(() => {
        const audioElement = audioTagRef.current;
        if (!audioElement) return;

        let playbackTimeout;

        // 재생 완료 이벤트
        const handleEnded = () => {
            console.log('✅ 오디오 재생 완료 (onended)');

            // Blob URL 정리
            cleanupBlobUrl();

            // AI 발화 종료
            if (aiSpeakingStartRef.current) {
                lastAiSpeakingTimeRef.current = {
                    startMs: aiSpeakingStartRef.current,
                    endMs: Date.now()
                };
            }

            setAiSpeaking(false);
            setVadStatus('idle');

            // 첫 인사 완료
            if (isInitialGreeting) {
                setIsInitialGreeting(false);
            }

            // 성공적인 재생 후 에러 카운트 초기화
            bufferErrorCountRef.current = 0;
        };

        // 재생 에러 이벤트
        const handleError = (e) => {
            console.error('❌ 오디오 재생 에러:', e);
            handlePlaybackError();
        };

        // 타임아웃 설정 (무한 대기 방지)
        const handlePlay = () => {
            playbackTimeout = setTimeout(() => {
                console.warn('⚠️ 재생 타임아웃 - 강제 종료');
                handleEnded();
            }, 30000); // 30초 타임아웃
        };

        const handlePause = () => {
            if (playbackTimeout) {
                clearTimeout(playbackTimeout);
            }
        };

        audioElement.addEventListener('ended', handleEnded);
        audioElement.addEventListener('error', handleError);
        audioElement.addEventListener('play', handlePlay);
        audioElement.addEventListener('pause', handlePause);

        return () => {
            audioElement.removeEventListener('ended', handleEnded);
            audioElement.removeEventListener('error', handleError);
            audioElement.removeEventListener('play', handlePlay);
            audioElement.removeEventListener('pause', handlePause);

            if (playbackTimeout) {
                clearTimeout(playbackTimeout);
            }
        };
    }, [isInitialGreeting, handlePlaybackError, cleanupBlobUrl]);

    // scenarioId가 없으면 기본값 반환
    if (!scenarioId) {
        return {
            connected: false,
            wsConnected: false,
            sessionId: null,
            transcripts: [],
            loading: false,
            aiSpeaking: false,
            userSpeaking: false,
            reconnecting: false,
            isInitialGreeting: true,
            isPttActive: false,
            vadStatus: 'idle',
            sttError: null,
            connectionError: null,
            initRealtimeConnection: () => Promise.reject(new Error('No scenario ID')),
            handleUserToggle: () => { },
            handleEndSession: () => Promise.resolve(),
            startPushToTalk: () => { },
            stopPushToTalk: () => { },
            audioTagRef: { current: null },
            lastUserSpeakingTime: null,
            lastAiSpeakingTime: null,
        };
    }

    return {
        connected,
        wsConnected,
        sessionId,
        transcripts,
        loading,
        aiSpeaking,
        userSpeaking,
        reconnecting,
        isInitialGreeting,

        isPttActive,
        vadStatus,
        sttError,
        connectionError,

        initRealtimeConnection,
        handleUserToggle,
        handleEndSession,

        startPushToTalk,
        stopPushToTalk,

        audioTagRef,

        lastUserSpeakingTime: lastUserSpeakingTimeRef.current,
        lastAiSpeakingTime: lastAiSpeakingTimeRef.current,
    };
}