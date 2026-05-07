import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { GoogleGenerativeAI, GenerativeModel, SchemaType } from '@google/generative-ai';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

import { MechanicAiService } from '../mechanic-ai/mechanic-ai.service';

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — SmartElec Buddy
// ═══════════════════════════════════════════════════════════════════
export const smartElecSystemPrompt = `Bạn là "SmartElec Buddy" - Chuyên gia kỹ thuật điện nước dạn dày kinh nghiệm, cực kỳ thân thiện và tâm lý.
Nhiệm vụ: Lắng nghe, chẩn đoán sự cố, đánh giá rủi ro và tư vấn an toàn.

══════════════════════════════════════════
QUY TẮC DỮ LIỆU & CHỐNG ẢO GIÁC
══════════════════════════════════════════
- Chỉ được sử dụng thông tin thiết bị có trong [THÔNG TIN THIẾT BỊ KHÁCH HÀNG] của khách hàng.
- Nếu khách hàng nói về một thiết bị KHÔNG có trong danh sách nội bộ: Hãy hỏi xác nhận đó có phải thiết bị mới không trước khi tiến hành chẩn đoán.
- Nếu có hình ảnh đính kèm: Hãy phân tích hình ảnh để tìm các dấu hiệu nguy hiểm (khói, tia lửa, rò rỉ, cháy xém) và cập nhật ngay vào phần "flags".

══════════════════════════════════════════
GIAI ĐOẠN 1 — THU THẬP THÔNG TIN (phase=COLLECTING)
══════════════════════════════════════════
- TUYỆT ĐỐI KHÔNG kết luận hay chẩn đoán ngay nếu thông tin triệu chứng còn mơ hồ (ví dụ: "máy không chạy", "hư rồi", "không hoạt động").
- Phải ĐẶT CÂU HỎI NGƯỢC LẠI cho khách để thu thập đủ dữ liệu. Tối đa 1-2 câu hỏi ngắn gọn, cụ thể mỗi lần.
- Áp dụng phương pháp loại trừ từng bước:
  • Hỏi về triệu chứng cụ thể: "Đèn báo có sáng không?", "Có nghe tiếng kêu lạ không?"
  • Hỏi về thời điểm xảy ra: "Sự cố xảy ra từ khi nào?", "Có vừa mất điện không?"
  • Hỏi về bối cảnh: "Đã kiểm tra phích cắm/aptomat chưa?", "Trước đó có ai đụng vào không?"
- Chỉ chuyển sang GIAI ĐOẠN 2 khi đã thu thập được ít nhất: Tên thiết bị + Triệu chứng cụ thể.
- Khi đang thu thập: field "phase" = "COLLECTING", "risk" = "UNKNOWN".

══════════════════════════════════════════
GIAI ĐOẠN 2 — CHẨN ĐOÁN (phase=DIAGNOSING)
══════════════════════════════════════════
--- 2A. PHÂN LOẠI RỦI RO ---
🔴 MỨC ĐỎ: mùi khét, khói, tia lửa, rò điện, aptomat nhảy liên tục.
🟡 MỨC VÀNG: Lỗi nguồn không ổn định, đèn báo lỗi, chập chờn, tự tắt/khởi động lại.
🟢 MỨC XANH: Lỗi vận hành thuần túy (không lạnh, không vắt đồ, ồn).

--- 2B. FORMAT OUTPUT ---
Lời phản hồi cho khách phải chuyên nghiệp, dùng Markdown để làm nổi bật từ khóa quan trọng.
Cấu trúc câu trả lời: Tóm tắt -> Nguyên nhân -> Hướng dẫn an toàn -> Kết luận.

══════════════════════════════════════════
QUY TẮC ĐẶT THỢ (BẮT BUỘC)
══════════════════════════════════════════
- Nếu khách hàng muốn gọi thợ hoặc đồng ý đặt lịch: BẮT BUỘC trả về is_booking_triggered = true trong JSON response.
`;

// ═══════════════════════════════════════════════════════════════════
// RESPONSE SCHEMA — Structured Output
// ═══════════════════════════════════════════════════════════════════
const responseSchema: any = {
  type: SchemaType.OBJECT,
  properties: {
    text: {
      type: SchemaType.STRING,
      description: 'Lời phản hồi cho khách hàng, có thể dùng Markdown',
    },
    state: {
      type: SchemaType.OBJECT,
      properties: {
        device:  { type: SchemaType.STRING, description: 'Tên thiết bị đang gặp sự cố' },
        symptom: { type: SchemaType.STRING, description: 'Mô tả triệu chứng' },
        ctx:     { type: SchemaType.STRING, description: 'Context phụ thêm' },
        phase: {
          type: SchemaType.STRING,
          enum: ['COLLECTING', 'DIAGNOSING', 'READY_TO_BOOK'],
          description: 'Giai đoạn hội thoại hiện tại',
        },
        risk: {
          type: SchemaType.STRING,
          enum: ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'],
          description: 'Mức độ rủi ro',
        },
        flags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Các tag nguy hiểm phát hiện được',
        },
      },
      required: ['phase', 'risk'],
    },
    is_booking_triggered: {
      type: SchemaType.BOOLEAN,
      description: 'true nếu khách đã đồng ý đặt thợ',
    },
  },
  required: ['text', 'state'],
};

// ═══════════════════════════════════════════════════════════════════
// SAFE FALLBACK STATE — trả về khi parse thất bại
// ═══════════════════════════════════════════════════════════════════
const SAFE_FALLBACK_STATE = {
  phase: 'COLLECTING',
  risk: 'UNKNOWN',
  device: null,
  symptom: null,
  flags: [],
};

@Injectable()
export class AiService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private readonly logger = new Logger(AiService.name);

  // Rate limiting: MAP lưu timestamp request gần nhất theo userId
  private lastRequestTime = new Map<number, number>();

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private mechanicAiService: MechanicAiService,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY') || '';
    this.genAI = new GoogleGenerativeAI(apiKey);

    this.model = this.genAI.getGenerativeModel({
      // ⚠️ QUY TẮC SẮT ĐÁ: KHÔNG ĐƯỢC ĐỔI PHIÊN BẢN 2.5 SANG BẢN KHÁC
      model: 'gemini-2.5-flash',
      systemInstruction: smartElecSystemPrompt,
      generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        topK: 40,
        // ✅ Structured Output: ép Gemini trả về JSON chuẩn 100%, không cần Regex
        responseMimeType: 'application/json',
        responseSchema,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // MAIN: Chat với AI
  // ═══════════════════════════════════════════════════════════════════
  async chatWithAI(
    userId: number,
    message: string,
    imageBase64?: string,
    history: any[] = [],
  ) {
    // ✅ VÁ BOM DỮ LIỆU: Chặn tin nhắn vượt 1000 ký tự — ngăn đốt sạch token quota
    if (message.length > 1000) {
      throw new HttpException(
        'Dạ tin nhắn dài quá, bác tóm tắt lại giúp em khoảng 3-4 câu nha!',
        HttpStatus.BAD_REQUEST,
      );
    }

    // ── RATE LIMIT ─────────────────────────────────────────────────
    const now = Date.now();
    const lastTime = this.lastRequestTime.get(userId) || 0;
    if (now - lastTime < 2000) {
      throw new HttpException(
        'Bạn đang thao tác quá nhanh, vui lòng đợi giây lát!',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.lastRequestTime.set(userId, now);

    // ✅ TỰ DỌN DẾỬP RAM định kỳ — chống Memory Leak cho Map (MVP workaround, dùng Redis ở Production cụm)
    if (this.lastRequestTime.size > 10_000) {
      this.lastRequestTime.clear();
      this.logger.warn('♻️ [RateLimit] Đã xóa Map rate-limit (đã vượt 10k entries)');
    }

    let sessionId: number | null = null;
    let prevState: any = null;

    try {
      // ── 1. LẤY TRẠNG THÁI PHIÊN TRƯỚC ─────────────────────────────
      const lastLog = await this.prisma.aiReasoningLog.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      prevState = lastLog?.nextState || null;
      const lastStateContext = prevState
        ? `\n[TRẠNG THÁI HIỆN TẠI]: ${JSON.stringify(prevState)}`
        : '';

      // ── 2. THÔNG TIN THIẾT BỊ CỦA KHÁCH ────────────────────────────
      const devices = await this.prisma.device.findMany({
        where: { userId },
        select: { category: true, brandName: true, modelCode: true },
      });

      let deviceContext = '';
      if (devices.length > 0) {
        deviceContext = `\n[THÔNG TIN THIẾT BỊ KHÁCH HÀNG]: Khách hàng có: ${devices.map((d) => `${d.brandName} ${d.category}`).join(', ')}`;
      }

      // ── 2.5. TRUY XUẤT KIẾN THỨC RAG ────────────────────────────────
      // Lấy role của user để phân quyền
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      const accessLevel = (user?.role === 'TECHNICIAN' || user?.role === 'ADMIN') ? 'ADVANCED' : 'BASIC';
      
      let ragContext = '';
      try {
        const ragRes = await this.mechanicAiService.findRelevantDocs(message, accessLevel, 3);
        let results = ragRes.results as any[];

        // Hybrid Search Logic: Ưu tiên tài liệu chứa mã lỗi nếu khách nhắc đến
        const errorCodesMatch = message.match(/\b[A-Z][0-9]\b|\b[A-Z]{2,3}[0-9]?\b/g); 
        if (errorCodesMatch && errorCodesMatch.length > 0) {
          results.sort((a, b) => {
            const aHasCode = errorCodesMatch.some(c => a.content.includes(c) || a.title.includes(c));
            const bHasCode = errorCodesMatch.some(c => b.content.includes(c) || b.title.includes(c));
            if (aHasCode && !bHasCode) return -1;
            if (!aHasCode && bHasCode) return 1;
            return 0;
          });
        }

        if (results && results.length > 0) {
          const docsText = results.map((d: any) => `- [${d.title}] (Nguồn: ${d.source || 'Tài liệu nội bộ'}): ${d.content}`).join('\n\n');
          ragContext = `
[KIẾN THỨC TỪ HỆ THỐNG]:
${docsText}

*Chỉ thị quan trọng*: Bạn phải ưu tiên sử dụng [KIẾN THỨC TỪ HỆ THỐNG] để trả lời. Nếu tài liệu ghi nhãn ADVANCED mà người dùng là khách thường, hãy cảnh báo nguy hiểm và không hướng dẫn chi tiết các bước tháo máy. Trả lời xong, hãy ghi thêm dòng: "(Tham khảo từ: [Tên tài liệu/Nguồn])" ở cuối.
`;
        }
      } catch (e) {
        this.logger.error('Lỗi khi gọi RAG:', e);
      }

      // ── 3. RLHF: TIÊU CHUẨN VÀNG (GOLDEN EXAMPLES) ────────────────
      const currentCategory = (prevState as any)?.device || (devices.length > 0 ? devices[0].category : '');
      let rlhfInstruction = '';
      if (currentCategory) {
        const examples = await this.getGoldenExamples(currentCategory, 2);
        if (examples.golden.length > 0 || examples.negative) {
          const goldenText = examples.golden
            .map((l, i) => `  [Tốt #${i + 1}] Khách: "${l.userMsg}"\n  AI: "${(l.aiResponse ?? '').substring(0, 300)}..."`)
            .join('\n\n');
          const negativeText = examples.negative
            ? `  [Xấu] Khách: "${examples.negative.userMsg}"\n  AI: "${(examples.negative.aiResponse ?? '').substring(0, 300)}..."`
            : '';

          rlhfInstruction = `
[VÍ DỤ TRẢ LỜI XUẤT SẮC ĐÃ CHỐT ĐƠN]:
${goldenText || '  (Chưa có)'}

[VÍ DỤ CẦN TRÁNH GÂY KHÓ CHỊU CHO KHÁCH]:
${negativeText || '  (Chưa có)'}
`;
          this.logger.log(`🧠 [RLHF] Injected ${examples.golden.length} Golden + ${examples.negative ? 1 : 0} Negative cho category "${currentCategory}"`);
        }
      }

      // ── 4. GỌI GEMINI ───────────────────────────────────────────────
      const userPrompt = `${ragContext}${rlhfInstruction}${deviceContext}${lastStateContext}\n\nKhách nhắn: ${message}`;
      const parts: any[] = [{ text: userPrompt }];
      if (imageBase64) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
      }

      // ✅ LỌC LỊCH SỬ GEMINI: Ép luân phiên user -> model, chống lỗi 400 "roles must alternate"
      const cleanHistory: { role: string; parts: { text: string }[] }[] = [];
      let expectedRole = 'user'; // Gemini yêu cầu bắt đầu bằng user
      for (const h of history.slice(-10)) {
        const mappedRole =
          h.role === 'assistant' || h.role === 'model' ? 'model' : 'user';
        if (mappedRole === expectedRole) {
          cleanHistory.push({ role: mappedRole, parts: [{ text: h.content }] });
          expectedRole = expectedRole === 'user' ? 'model' : 'user';
        }
        // bỏ qua tin nhắn sai thứ tự (2 user liền nhau, v.v.)
      }
      // Gemini không cho phép history kết thúc bằng 'user' (vì sendMessage ngay sau sẽ thêm user nữa)
      if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === 'user') {
        cleanHistory.pop();
      }

      const chat = this.model.startChat({ history: cleanHistory });

      const result   = await chat.sendMessage(parts);
      const response = result.response;

      // ── 5. PARSE JSON (Structured Output) ─────────────────────────
      let parsed: any;
      const rawText = response.text();
      try {
        // Với responseMimeType:"application/json", Gemini đảm bảo rawText là JSON hợp lệ
        parsed = JSON.parse(rawText);
      } catch (e) {
        // Trường hợp cực hiếm — vẫn bảo vệ bằng safe fallback
        this.logger.warn(`⚠️ JSON.parse thất bại (hiếm gặp). rawText: ${rawText.substring(0, 200)}`);
        parsed = {
          text: 'Dạ em chưa hiểu rõ câu hỏi, bác vui lòng mô tả thêm ạ!',
          state: prevState || SAFE_FALLBACK_STATE,
          is_booking_triggered: false,
        };
      }

      // ── 6. XỬ LÝ BOOKING (is_booking_triggered) ───────────────────
      if (parsed.is_booking_triggered) {
        const device = parsed.state?.device || (prevState as any)?.device || 'thiết bị';
        const symptom = parsed.state?.symptom || (prevState as any)?.symptom || 'sự cố';
        
        sessionId = await this.saveRepairCase(userId, device, symptom, parsed.text || 'Booking via AI');

        // ✅ KHÔNG ghi đè text nữa, để AI tự trả lời tự nhiên, chỉ bổ sung flag để Flutter hiện nút
        return {
          ...parsed,
          sessionId,
        };
      }

      // ── 7. ĐỒNG BỘ DANGER KEYWORDS ──────────────────────────────────
      const dangerKeywords = [
        'smoke', 'spark', 'fire', 'electric_leak', 'shocks',
        'khói', 'lửa', 'tia lửa', 'cháy', 'khét', 'nổ', 'giật',
        'rò điện', 'tóe lửa', 'chập điện', 'bốc khói',
      ];
      const hasDangerFlag = parsed.state?.flags?.some((f: string) =>
        dangerKeywords.includes(f.toLowerCase()),
      );

      if (parsed.state?.risk === 'RED' || hasDangerFlag) {
        parsed.text = `⚠️ **CẢNH BÁO KHẨN CẤP: Vui lòng đứng tránh xa và ngắt ngay cầu dao tổng trước khi tiếp tục!**\n\n${parsed.text}`;
      }

      // ── 8. LƯU REPAIR CASE (nếu đủ thông tin) ──────────────────────
      if (parsed.state?.device && parsed.state.symptom) {
        sessionId = await this.saveRepairCase(
          userId,
          parsed.state.device,
          parsed.state.symptom,
          parsed.text,
        );
      }

      // ── 9. LƯU REASONING LOG & LẤY logId CHO RLHF ──────────────────
      let logId: number | null = null;
      try {
        logId = await this.saveReasoningLog(userId, sessionId, message, prevState, parsed);
      } catch (e) {
        this.logger.error('Failed to save reasoning log', e);
      }

      return { ...parsed, sessionId, logId };

    } catch (error: any) {
      this.logger.error(`AI Error: ${error.message}`);

      // Xử lý Rate Limit từ Google (429)
      if (error.message?.includes('429')) {
        return {
          text: 'Dạ hiện tại lượt dùng thử Gemini đang hết, anh/chị đợi em xíu hoặc thử lại sau nha!',
          state: null,
        };
      }

      // Chuyển tiếp lỗi nội bộ (rate limit app)
      if (error instanceof HttpException) throw error;

      return { 
        text: 'Dạ hệ thống AI đang bận (Lỗi: ' + error.message + '), bác thử lại sau xíu nha!', 
        state: prevState || null 
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════

  private async saveReasoningLog(
    userId: number,
    sessionId: number | null,
    userMsg: string,
    prevState: any,
    parsed: any,
  ): Promise<number | null> {
    try {
      const isBooking = parsed.is_booking_triggered === true || parsed.is_booking_triggered === 'true';
      const score = isBooking ? 10 : 0;
      const deviceCategory = parsed?.state?.device || null;

      const log = await this.prisma.aiReasoningLog.create({
        data: {
          userId,
          sessionId,
          userMsg,
          prevState: prevState || null,
          nextState: parsed?.state || null,
          riskLevel: parsed?.state?.risk || 'UNKNOWN',
          aiResponse: parsed?.text || '',
          score: score,
          deviceCategory: deviceCategory,
          isGolden: isBooking,
        },
      });
      return log.id;
    } catch (err) {
      this.logger.error('Error saving reasoning log to DB', err);
      return null;
    }
  }

  private async saveRepairCase(
    userId: number,
    deviceType: string,
    symptom: string,
    summary: string,
  ): Promise<number | null> {
    try {
      const recentCase = await this.prisma.chatSession.findFirst({
        where: {
          userId,
          deviceType,
          symptom,
          createdAt: { gte: new Date(Date.now() - 1000 * 60 * 30) },
        },
      });
      if (recentCase) return recentCase.id;

      const newCase = await this.prisma.chatSession.create({
        data: { userId, deviceType, symptom, aiSummary: summary, status: 'AI_CONSULTING' },
      });
      return newCase.id;
    } catch (error: any) {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // RLHF: Lưu phản hồi Like/Dislike vào AiReasoningLog
  // ─────────────────────────────────────────────────────────────────
  async saveFeedback(logId: number, feedback: 'LIKE' | 'DISLIKE') {
    const log = await this.prisma.aiReasoningLog.findUnique({ where: { id: logId } });
    if (!log) {
      throw new Error(`Không tìm thấy AI log với ID = ${logId}`);
    }

    const scoreIncrement = feedback === 'LIKE' ? 2 : -5;

    await this.prisma.aiReasoningLog.update({
      where: { id: logId },
      data: { 
        aiFeedback: feedback,
        score: { increment: scoreIncrement }
      },
    });
    this.logger.log(`👍 [RLHF] User #${log.userId} đã ${feedback} log #${logId}. Score được cập nhật: ${scoreIncrement > 0 ? '+' : ''}${scoreIncrement}`);
    return { success: true, feedback };
  }

  // ─────────────────────────────────────────────────────────────────
  // TRUY XUẤT GOLDEN EXAMPLES (Phục vụ cho Prompting dựa trên phản hồi)
  // ─────────────────────────────────────────────────────────────────
  async getGoldenExamples(category: string, limit: number = 2) {
    // 1. Lấy top câu tốt nhất liên quan đến loại thiết bị
    const golden = await this.prisma.aiReasoningLog.findMany({
      where: { 
        deviceCategory: { contains: category, mode: 'insensitive' },
        OR: [{ score: { gt: 5 } }, { isGolden: true }],
        aiResponse: { not: null }
      },
      orderBy: { score: 'desc' },
      take: limit,
      select: { userMsg: true, aiResponse: true }
    });

    // 2. Lấy 1 câu xấu nhất (để làm negative example)
    const negative = await this.prisma.aiReasoningLog.findFirst({
      where: {
        deviceCategory: { contains: category, mode: 'insensitive' },
        score: { lt: 0 },
        aiResponse: { not: null }
      },
      orderBy: { score: 'asc' },
      select: { userMsg: true, aiResponse: true }
    });

    return { golden, negative };
  }
}
