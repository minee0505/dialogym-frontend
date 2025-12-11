import React, {useEffect, useRef, useState} from 'react';
import {useLocation, useNavigate} from "react-router-dom";
import {useRealtimeSession} from "@/hooks/useRealtimeSession.js";
import useSessionStore from "@/stores/sessionStore.js";
import apiClient from "@/services/apiClient.js";
import styles from "./DialoguePage.module.scss";
import {FiMic, FiMicOff, FiX} from "react-icons/fi";
import {useAuthUser} from "@/stores/authStore.js";

const DialoguePage = () => {

    const location = useLocation();
    const navigate = useNavigate();
    const messagesEndRef = useRef(null);

    // 시나리오 정보
    const scenarioId = location.state?.scenarioId;
    const title = location.state?.scenarioTitle;

    // 유저 정보 (추후 authStore에서 가져오게 수정)
    const userId = useAuthUser()?.userId;

    // 세션 상태 관리
    const { getExistingSession } = useSessionStore();

    // 페이지 상태 관리
    const [pageStatus, setPageStatus] = useState('checking'); // 'checking' | 'blocked' | 'connecting'
    const [blockReason, setBlockReason] = useState('');

    // 리액트 커스텀 훅
    const {
        sessionId: currentSessionId,
        connected,
        wsConnected,
        transcripts,
        loading,
        aiSpeaking,
        isPttActive,
        isInitialGreeting,
        sttError,
        connectionError,
        initRealtimeConnection,
        handleUserToggle,
        handleEndSession,
        audioTagRef,
    } = useRealtimeSession(scenarioId || null, userId);

    // 세션 상태 체크
    useEffect(() => {
        if (!scenarioId) {
            setPageStatus('blocked');
            setBlockReason('시나리오 정보가 없습니다.');
            console.log('시나리오 정보가 없습니다.');
            return;
        }

        const checkSession = async () => {
            // 1. 로컬 세션 확인
            const localSession = getExistingSession(scenarioId, userId);
            
            // 2. 로컬에 세션이 있으면 백엔드에서 실제 상태 확인
            if (localSession?.sessionId) {
                try {
                    console.log('백엔드 세션 상태 확인:', localSession.sessionId);
                    const response = await apiClient.get(`/sessions/${localSession.sessionId}`);
                    const backendSession = response.data.data;

                    console.log('백엔드 세션 상태:', backendSession.status);
                    console.log('로컬 세션 상태: ', localSession.status);

                    // 백엔드 상태로 최종 결정
                    if (backendSession.status === 'COMPLETED' && localSession.status === 'completed') {
                        console.log('✅ 완료된 시나리오 감지');
                        setPageStatus('blocked');
                        setBlockReason('완료된 시나리오입니다.\n다른 시나리오를 선택해주세요.');
                    } else if (backendSession.status === 'ABANDONED' || localSession.status === 'abandoned') {
                        console.log('✅ 중단된 시나리오 감지 - 로컬 스토리지 초기화');
                        // 중단된 세션 정보 삭제
                        localStorage.removeItem(`session_${scenarioId}_${userId}`);
                        // 새로 시작
                        setPageStatus('connecting');
                    } else if (backendSession.status === 'ONGOING' || localSession.status === 'failed') {
                        console.log('진행 중인 세션을 복구합니다.');
                        setPageStatus('connecting');
                    } else if (backendSession.status === 'FAILED' || localSession.status === 'failed') {
                        console.log('✅ 연결 실패 감지');
                        setPageStatus('blocked');
                        setBlockReason('연결에 실패했습니다.\n잠시 후 다시 시도해주세요.');
                    } else {
                        setPageStatus('connecting');
                    }
                } catch (error) {
                    console.log('백엔드 세션 조회 실패, 로컬 스토리지 무시하고 새 세션 시작:', error);
                    // 백엔드에 세션이 없으면 로컬 스토리지가 꼬인 것이므로 무시하고 새 세션 시작
                    setPageStatus('connecting');
                }
            } else {
                // 로컬에 세션이 없으면 새로 시작
                console.log('로컬 세션 없음, 새 세션 시작');
                setPageStatus('connecting');
            }
        };

        checkSession();
    }, [scenarioId, userId, getExistingSession, navigate]);

    // 연결 에러 감지 (마이크 끊김 등)
    useEffect(() => {
        if (connectionError) {
            console.log('🚨 연결 에러 감지:', connectionError);
            setPageStatus('blocked');
            setBlockReason(connectionError.message);
        }
    }, [connectionError]);

    // 연결 시작 (pageStatus가 'connecting'일 때만)
    useEffect(() => {
        if (pageStatus !== 'connecting') return;

        let isCancelled = false;

        console.log('🚀 대화 페이지 진입 - 연결 시작:', scenarioId);

        console.log('연결 시작...');

        initRealtimeConnection()
            .then(() => {
                if (!isCancelled) {
                    console.log('✅ 연결 성공');
                }
            })
            .catch((error) => {
                if (!isCancelled) {
                    let errorMessage = '연결에 실패했습니다.\n다시 시도해주세요.';

                    // 마이크 권한 관련 에러 처리
                    if (error.message.includes('마이크') || error.message.includes('Permission denied')) {
                        // 마이크 권한 거부 시 특별 처리 - 홈으로 이동하지 않음
                        setPageStatus('blocked');
                        setBlockReason('마이크 권한이 필요합니다.\n브라우저에서 마이크 권한을 허용하고 새로고침해주세요.');
                    } else {
                        // 다른 에러는 기존 처리
                        console.error('연결 실패:', errorMessage);
                        console.error('❌ 연결 실패:', error);
                    }


                }
            });

        return () => {
            isCancelled = true;
        };
    }, [pageStatus, scenarioId, initRealtimeConnection, navigate]);

    // 차단된 페이지 자동 이동
    useEffect(() => {
        if (pageStatus === 'blocked') {
            console.log('페이지 차단:', blockReason);
            // 자동 이동 제거 - 사용자가 버튼으로 직접 이동
        }
    }, [pageStatus, blockReason, navigate]);


    // 메시지 추가 시 자동 스크롤
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    useEffect(() => {
        scrollToBottom();
    }, [transcripts])

    // 대화 중도 포기 (X 버튼)
    const handleEndDialogue = async () => {
        const confirmed = window.confirm('대화를 중단하시겠습니까?');

        if (!confirmed) return;

        console.log('대화 종료 중...');

        try {
            await handleEndSession(false); // 중단으로 처리
            console.log('✅ 대화가 중단되었습니다');
            navigate('/scenarios');
        } catch (error) {
            console.error('❌ 대화 종료 실패:', error);
        }
    };

    // 대화 완료 (완료 버튼)
    const handleCompleteDialogue = async () => {
        const confirmed = window.confirm('대화 연습을 완료하시겠습니까?\n피드백을 확인할 수 있습니다.');

        if (!confirmed) return;

        console.log('대화 완료 중...');

        try {
            console.log('🔍 세션 완료 처리 시작:', currentSessionId);
            await handleEndSession(true); // 완료로 처리
            console.log('✅ 대화 연습이 완료되었습니다');
            console.log('🔍 피드백 페이지로 이동:', `/feedback/${currentSessionId}`);
            // 피드백 페이지로 이동
            navigate(`/feedback/${currentSessionId}`);
        } catch (error) {
            console.error('❌ 대화 완료 실패:', error);

        }
    };

    // 시간 포맷팅
    const formatTime = (timestamp) => {
        const date = new Date(timestamp);
        const hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? '오후' : '오전';
        const displayHours = hours % 12 || 12;
        return `${ampm} ${displayHours}:${minutes.toString().padStart(2, '0')}`;
    };

    // 연결 상태별 UI 표시
    const getStatusText = () => {
        if (loading) return 'AI 친구를 소환하는 중...';
        if (!connected) return '차원의 문을 여는 중...';
        if (!wsConnected) return '텔레파시 채널 연결 중...';
        if (isInitialGreeting) return 'AI가 인사를 준비하는 중...';
        return 'AI와 대화 중';
    };

    const getStatusColor = () => {
        if (loading || !connected || !wsConnected) return '#F59E0B'; // 주황
        if (isInitialGreeting) return '#6B8EE8'; // 블루
        return '#10B981'; // 초록
    };


    // 차단된 페이지 렌더링
    if (pageStatus === 'blocked') {
        return (
            <div className={styles.pageContainer}>
                <div className={styles.blockedContainer}>
                    <div className={styles.blockedContent}>
                        <h2 className={styles.blockedTitle}></h2>
                        <p className={styles.blockedMessage}>{blockReason}</p>
                        <button
                            className={styles.goBackButton}
                            onClick={() => navigate('/scenarios')}
                        >
                            시나리오 목록으로 돌아가기
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // 세션 체크 중 렌더링
    if (pageStatus === 'checking') {
        return (
            <div className={styles.pageContainer}>
                <div className={styles.loadingOverlay}>
                    <div className={styles.loadingContent}>
                        <div className={styles.spinner}></div>
                        <p className={styles.loadingText}>세션 확인 중...</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.pageContainer}>
            {/* 숨겨진 오디오 태그 (AI 음성 재생용) */}
            <audio ref={audioTagRef} style={{ display: 'none' }} />

            {/* 헤더 */}
            <header className={styles.header}>
                <div className={styles.headerContent}>
                    <h1 className={styles.scenarioTitle}>
                        {title}
                    </h1>
                    <p className={styles.scenarioSubtitle}>
                        <span
                            className={styles.statusDot}
                            style={{ backgroundColor: getStatusColor() }}
                        />
                        {getStatusText()}
                    </p>
                </div>
                <button
                    className={styles.closeButton}
                    onClick={handleEndDialogue}
                    disabled={loading}
                >
                    <FiX />
                </button>
            </header>

            {/* 로딩 오버레이 */}
            {(loading || !connected || !wsConnected) && (
                <div className={styles.loadingOverlay}>
                    <div className={styles.loadingContent}>
                        <div className={styles.spinner}></div>
                        <p className={styles.loadingText}>{getStatusText()}</p>
                        {!connected && <p className={styles.loadingSubtext}>연결 중...</p>}
                        {connected && !wsConnected && <p className={styles.loadingSubtext}>연결 중...</p>}
                    </div>
                </div>
            )}

            {/* 메시지 영역 */}
            <div className={styles.messagesContainer}>
                <div className={styles.messagesList}>
                    {transcripts.map((transcript, index) => (
                        <div
                            key={index}
                            className={`${styles.messageWrapper} ${transcript.speaker === 'user' ? styles.userMessage : styles.aiMessage
                                }`}
                        >
                            <div className={`${styles.messageBubble} ${transcript.isTemp ? styles.tempBubble : ''
                                }`}>
                                <p className={styles.messageText}>
                                    {transcript.text}
                                    {transcript.isTemp && <span className={styles.cursor}></span>}
                                </p>
                                {!transcript.isTemp && (
                                    <span className={styles.messageTime}>
                                        {formatTime(transcript.timestamp)}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}

                    {/* AI 발화 중 표시 */}
                    {aiSpeaking && transcripts.filter(t => !t.isTemp).length > 0 && (
                        <div className={`${styles.messageWrapper} ${styles.aiMessage}`}>
                            <div className={`${styles.messageBubble} ${styles.speakingBubble}`}>
                                <div className={styles.speakingIndicator}>
                                    <span></span>
                                    <span></span>
                                    <span></span>
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>
            </div>

            {/* STT 에러 메시지 */}
            {sttError && (
                <div className={styles.sttErrorContainer}>
                    <div className={styles.sttErrorMessage}>
                        {sttError}
                    </div>
                </div>
            )}

            {/* 음성 입력 컨트롤 */}
            <div className={styles.controlPanel}>
                {/* PTT 마이크 버튼 + 타이머 링 */}
                <div className={styles.micContainer}>
                    {/* 타이머 링 (녹음 중일 때만 표시) */}
                    {isPttActive && (
                        <svg className={styles.timerRing} viewBox="0 0 100 100">
                            <circle
                                className={styles.timerCircle}
                                cx="50" cy="50" r="45"
                            />
                        </svg>
                    )}

                    {/* 마이크 버튼 */}
                    <button
                        className={`${styles.micButton} ${isPttActive ? styles.recording : ''
                            } ${aiSpeaking || isInitialGreeting || !connected ? styles.disabled : ''}`}
                        onClick={handleUserToggle}
                        disabled={!connected || aiSpeaking || isInitialGreeting || loading}
                    >
                        {isPttActive ? <FiMicOff size={32} /> : <FiMic size={32} />}
                    </button>
                </div>

                {/* 상태 안내 텍스트 */}
                <p className={styles.statusHint}>
                    {isPttActive
                        ? '말하는 중...'
                        : aiSpeaking
                            ? 'AI 응답 중...'
                            : isInitialGreeting
                                ? 'AI 인사를 기다리는 중...'
                                : '마이크 버튼을 눌러 답변하세요'}
                </p>

                {/* 완료 버튼 */}
                {connected && !isInitialGreeting && (
                    <button
                        className={styles.completeButton}
                        onClick={handleCompleteDialogue}
                        disabled={loading || aiSpeaking || isPttActive}
                    >
                        대화 완료
                    </button>
                )}
            </div>
        </div>
    );
};

export default DialoguePage;