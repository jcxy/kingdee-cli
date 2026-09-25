import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, Server } from 'node:http';

/** 写端点名清单：UnAudit 排在 Audit 之前匹配（两者 endsWith 前缀重叠） */
const WRITE_SERVICES = ['Save', 'Submit', 'UnAudit', 'Audit', 'Delete', 'ExecuteOperation', 'Push'];

export interface StubRequest {
  /** kdsvc 服务名（从 URL 提取） */
  service: string;
  /** 业务参数数组：从请求信封的 parameters 字段提取（与真实协议一致） */
  body: unknown;
  /** 原始请求信封（format/useragent/rid/parameters/timestamp/v）；客户端回归裸数组时为 null */
  envelope: Record<string, unknown> | null;
  headers: IncomingHttpHeaders;
}

export interface StubServer {
  url: string;
  requests: StubRequest[];
  /** 预设登录剧本：默认仅密码 "good" / 密钥 "good-secret" 成功 */
  loginPassword: string;
  loginSecret: string;
  loginResultType: number | null; // 覆盖剧本，强制返回该结果
  /** 登录失败时返回的错误文案（模拟金蝶原始报文） */
  loginMessage: string;
  /** 设置后无视登录剧本，原样返回该响应体（模拟非 JSON/网关拦截） */
  rawBody: string | null;
  /** 设置后所有 DynamicFormService 端点返回业务失败信封 */
  businessErrors: string[] | null;
  /** 仅写端点（Save/Submit/UnAudit/Audit/Delete/...）返回业务失败；不影响查询 */
  writeErrors: string[] | null;
  /** ExecuteBillQuery 成功响应（二维数组），null 则返回业务失败 */
  queryRows: unknown[][] | null;
  /** 按 FormId 覆盖查询剧本（链条场景：不同环节不同结果）；未命中 FormId 时回退 queryRows */
  queryRowsByForm: Record<string, unknown[][]> | null;
  /** 函数式查询剧本：按查询参数（含 Limit/StartRow）动态返回行；优先于 queryRows */
  queryFn:
    | ((params: {
        FormId?: string;
        FieldKeys?: string;
        FilterString?: string;
        OrderString?: string;
        Limit?: number;
        StartRow?: number;
      }) => unknown[][] | null)
    | null;
  /** View 完整响应体（含 Result 信封），可任意构造（如 { Result: null }） */
  viewResponse: Record<string, unknown> | null;
  /** QueryBusinessInfo 完整响应体（含 Result 信封），可任意构造 */
  metadataResponse: Record<string, unknown> | null;
  /** 写端点（Save/Submit/Audit/UnAudit/Delete/ExecuteOperation/Push）完整响应体 */
  writeResponse: Record<string, unknown> | null;
  close: () => Promise<void>;
}

/**
 * 模拟 K3Cloud kdsvc 端点（登录 + DynamicFormService 查询/查看/元数据）。
 * 测试唯一接缝（CLI 进程边界）的另一半：CLI 指向此 stub 全链路运行。
 */
export function startStubServer(): Promise<StubServer> {
  const stub: StubServer = {
    url: '',
    requests: [],
    loginPassword: 'good',
    loginSecret: 'good-secret',
    loginResultType: null,
    loginMessage: '用户名或密码错误',
    rawBody: null,
    businessErrors: null,
    writeErrors: null,
    queryRowsByForm: null,
    queryFn: null,
    queryRows: [
      [100001, 'XSDD0001'],
      [100002, 'XSDD0002'],
    ],
    viewResponse: {
      Result: {
        Id: 100001,
        Number: 'XSDD0001',
        FDate: '2026-09-01',
        DocumentStatus: 'C',
      },
    },
    metadataResponse: {
      Result: {
        BusinessInfo: {
          Header: { TableName: 'T_SAL_ORDER', Fields: [{ Key: 'FID' }, { Key: 'FBillNo' }] },
        },
      },
    },
    writeResponse: {
      Result: {
        ResponseStatus: {
          IsSuccess: true,
          Errors: [],
          SuccessEntitys: [{ Id: '100001', Number: 'XSDD0001' }],
        },
      },
    },
    close: async () => {},
  };

  function respond(res: http.ServerResponse, loginResultType: number): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      // 金蝶登录成功时会种会话 Cookie，模拟之以便断言 cookie 收集逻辑
      'Set-Cookie': 'kdservice-sessionid=stub-session; path=/',
    });
    if (stub.rawBody !== null) {
      res.end(stub.rawBody);
      return;
    }
    res.end(
      JSON.stringify(
        loginResultType === 1
          ? { LoginResultType: 1, Context: { UserId: '0001', UserName: 'tester' } }
          : { LoginResultType: -1, Message: stub.loginMessage, MessageCode: 0 },
      ),
    );
  }

  /** 金蝶业务失败统一信封 */
  function respondBusinessFailure(res: http.ServerResponse, messages: string[]): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        Result: {
          ResponseStatus: {
            IsSuccess: false,
            Errors: messages.map((m) => ({ Message: m, FieldName: null })),
            SuccessEntitys: [],
            SuccessMessages: [],
            MsgCode: 0,
          },
        },
      }),
    );
  }

  function respondBusinessSuccess(res: http.ServerResponse, payload: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  /** DynamicFormService 端点统一路由：失败剧本优先；成功载荷为 null 也视为业务失败 */
  function respondBusiness(
    res: http.ServerResponse,
    serviceName: string,
    successPayload: unknown,
  ): void {
    if (stub.businessErrors || successPayload === null) {
      respondBusinessFailure(res, stub.businessErrors ?? ['stub 预设业务失败']);
      return;
    }
    respondBusinessSuccess(res, successPayload);
  }

  /** 写端点路由：writeErrors 优先（仅写失败），其次 businessErrors */
  function respondWrite(res: http.ServerResponse, payload: unknown): void {
    const failures = stub.writeErrors ?? stub.businessErrors;
    if (failures) {
      respondBusinessFailure(res, failures);
      return;
    }
    if (payload === null) {
      respondBusinessFailure(res, ['stub 预设业务失败']);
      return;
    }
    respondBusinessSuccess(res, payload);
  }

  /** 模拟真实 kdsvc 对裸参数数组的拒绝（T7 真实环境校准实测原样报文） */
  function respondShowErrMsg(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      JSON.stringify({
        actionname: 'ShowErrMsg',
        params: [
          {
            errorTitle: '金蝶温馨提示: 应用服务器发生错误，请联系系统管理员检修！',
            errorInfo: 'Additional text found in JSON string after finishing deserializing object.',
          },
        ],
      }),
    );
  }

  const server: Server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      const service = new URL(req.url ?? '/', 'http://localhost').pathname
        .replace('/K3Cloud/', '')
        .replace('.common.kdsvc', '');
      let body: unknown = null;
      try {
        body = JSON.parse(data);
      } catch {
        body = data;
      }
      // T7 校准：真实 kdsvc 端点要求 JSON 信封对象，裸参数数组被 500 拒绝。
      // stub 同步此语义：body 字段存从信封提取的业务参数数组（保持断言语义不变），
      // 客户端若回归裸数组，envelope 为 null → ShowErrMsg → 全链路测试红。
      let params: unknown[] | null = null;
      let envelope: Record<string, unknown> | null = null;
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const obj = body as Record<string, unknown>;
        if (Array.isArray(obj.parameters)) {
          envelope = obj;
          params = obj.parameters as unknown[];
        }
      }
      stub.requests.push({ service, body: params, envelope, headers: req.headers });

      if (!params) {
        respondShowErrMsg(res);
        return;
      }
      if (service.endsWith('AuthService.ValidateUser')) {
        const [, , password] = params as unknown[];
        respond(res, stub.loginResultType ?? (password === stub.loginPassword ? 1 : -1));
      } else if (service.endsWith('AuthService.LoginByAppSecret')) {
        const [, , , secret] = params as unknown[];
        respond(res, stub.loginResultType ?? (secret === stub.loginSecret ? 1 : -1));
      } else if (service.endsWith('DynamicFormService.ExecuteBillQuery')) {
        const first = params[0] as { FormId?: string } | undefined;
        const rows = stub.queryFn
          ? stub.queryFn((first ?? {}) as Record<string, unknown>)
          : stub.queryRowsByForm && first?.FormId && first.FormId in stub.queryRowsByForm
            ? stub.queryRowsByForm[first.FormId]
            : stub.queryRows;
        respondBusiness(res, service, rows);
      } else if (service.endsWith('DynamicFormService.View')) {
        respondBusiness(res, service, stub.viewResponse);
      } else if (service.endsWith('DynamicFormService.QueryBusinessInfo')) {
        respondBusiness(res, service, stub.metadataResponse);
      } else if (WRITE_SERVICES.some((n) => service.endsWith(`DynamicFormService.${n}`))) {
        respondWrite(res, stub.writeResponse);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `stub 未实现服务: ${service}` }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      stub.url = `http://127.0.0.1:${port}/k3cloud/`;
      stub.close = () => new Promise<void>((done) => server.close(() => done()));
      resolve(stub);
    });
  });
}
