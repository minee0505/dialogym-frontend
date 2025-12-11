// src/pages/Feedback/FeedbackGenerationPage.jsx
import styles from './FeedbackGenerationPage.module.scss';
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { generateFeedback, chooseFeedbackAlternative } from '@/services/feedbackService';
import FeedbackLoadingView from '@/components/Feedback/FeedbackLoadingView';
import FeedbackResultView from '@/components/Feedback/FeedbackResultView';
import toast from 'react-hot-toast';

/**
 * 피드백 생성 페이지
 * 대화 완료 후 AI 피드백을 생성하고 표시
 */
const FeedbackGenerationPage = () => {
    const { sessionId } = useParams();
    const navigate = useNavigate();

    const [loading, setLoading] = useState(true);
    const [feedback, setFeedback] = useState(null);
    const [error, setError] = useState('');

    // 피드백 생성
    useEffect(() => {
        if (!sessionId) {
            toast.error('세션 정보가 없습니다.');
            navigate('/scenarios');
            return;
        }

        const fetchFeedback = async () => {
            try {
                setLoading(true);
                console.log('🔍 피드백 생성 요청 시작:', sessionId);
                const data = await generateFeedback(sessionId);
                console.log('✅ 피드백 데이터 받음:', data);
                console.log('📊 데이터 구조:', {
                    totalScore: data?.totalScore,
                    scoreGrade: data?.scoreGrade,
                    alternativeA: data?.alternativeA,
                    alternativeB: data?.alternativeB,
                    alternativeC: data?.alternativeC,
                    improvementPoints: data?.improvementPoints,
                });
                setFeedback(data);
            } catch (err) {
                console.error('피드백 생성 실패:', err);
                console.error('에러 상세:', {
                    status: err.response?.status,
                    data: err.response?.data,
                    message: err.message,
                    sessionId: sessionId
                });
                const errorData = err.response?.data;
                let errorMessage = errorData?.detail || errorData?.message || errorData?.error || '피드백 생성에 실패했습니다.';
                
                // AI 분석 실패 시 더 자세한 안내
                if (errorData?.errorCode === 'AI_ANALYSIS_FAILED') {
                    errorMessage = 'AI 피드백 생성 중 오류가 발생했습니다.\n백엔드 서버 로그를 확인해주세요.';
                }
                
                setError(errorMessage);
                toast.error(errorMessage);
            } finally {
                setLoading(false);
            }
        };

        fetchFeedback();
    }, [sessionId, navigate]);

    // 개선안 선택
    const handleChooseAlternative = async (choice) => {
        try {
            const updatedFeedback = await chooseFeedbackAlternative(sessionId, choice);
            console.log('✅ 개선안 선택 후 업데이트된 피드백:', updatedFeedback);
            console.log('📊 업데이트된 데이터 구조:', {
                totalScore: updatedFeedback?.totalScore,
                scoreGrade: updatedFeedback?.scoreGrade,
                chosenAlternative: updatedFeedback?.chosenAlternative,
                aiGeneratedFeedback: updatedFeedback?.aiGeneratedFeedback,
                improvementPoints: updatedFeedback?.improvementPoints,
            });
            
            // 기존 피드백 데이터를 유지하면서 선택 정보만 업데이트
            setFeedback(prevFeedback => {
                // null이 아닌 값만 업데이트
                const merged = { ...prevFeedback };
                
                // 선택 관련 필드는 항상 업데이트
                merged.chosenAlternative = updatedFeedback.chosenAlternative;
                merged.finalChoice = updatedFeedback.finalChoice;
                merged.isChoiceComplete = updatedFeedback.isChoiceComplete;
                
                // null이 아닌 값만 업데이트 (기존 값 보존)
                Object.keys(updatedFeedback).forEach(key => {
                    if (updatedFeedback[key] !== null && updatedFeedback[key] !== undefined) {
                        merged[key] = updatedFeedback[key];
                    }
                });
                
                return merged;
            });
            
            toast.success(`개선안 ${choice}를 선택했습니다.`);
        } catch (err) {
            console.error('개선안 선택 실패:', err);
            toast.error('개선안 선택에 실패했습니다.');
        }
    };

    // 닫기 (시나리오 목록으로 이동)
    const handleClose = () => {
        navigate('/scenarios');
    };

    // 에러 화면
    if (error && !loading) {
        return (
            <div className={styles['feedback-page']}>
                <div className={styles['feedback-page__error']}>
                    <h2>피드백 생성 실패</h2>
                    <p>{error}</p>
                    <button onClick={handleClose}>시나리오 목록으로</button>
                </div>
            </div>
        );
    }

    return (
        <div className={styles['feedback-page']}>
            {loading && <FeedbackLoadingView />}
            {!loading && feedback && (
                <FeedbackResultView
                    feedback={feedback}
                    onChooseAlternative={handleChooseAlternative}
                    onClose={handleClose}
                />
            )}
        </div>
    );
};

export default FeedbackGenerationPage;
