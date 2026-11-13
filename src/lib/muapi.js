// 阶段 4.5.3：旧版客户端生成 SDK 已 fail-closed。
//
// 本文件此前在浏览器中直接持有供应商密钥并直连供应商 API。
// 该路径与阶段 4 的 Provider 契约冲突（账本、幂等、成本观测都要求服务端是唯一出口），
// 因此保留方法签名以维持调用方可编译，但不再读取凭据、不再发起任何网络请求。
//
// 服务端 Provider 接入后，生成请求应走服务端接口；不要在此文件恢复密钥读取。
import { ProviderUnavailableError, throwProviderUnavailable } from './providerAvailability.js';

export class MuapiClient {
    getKey() {
        // 兼容旧调用方的显式报错，但绝不再从 localStorage / window 读取密钥。
        throw new ProviderUnavailableError();
    }

    async generateImage() {
        return throwProviderUnavailable();
    }

    async generateVideo() {
        return throwProviderUnavailable();
    }

    async generateI2I() {
        return throwProviderUnavailable();
    }

    async generateI2V() {
        return throwProviderUnavailable();
    }

    async processV2V() {
        return throwProviderUnavailable();
    }

    async processLipSync() {
        return throwProviderUnavailable();
    }

    /**
     * 上传同样需要服务端 Provider；此处不再向供应商发送文件。
     */
    async uploadFile() {
        return throwProviderUnavailable();
    }

    async pollForResult() {
        return throwProviderUnavailable();
    }

    getDimensionsFromAR(ar) {
        // 纯计算，无凭据、无网络，保留给本地推理路径使用。
        switch (ar) {
            case '1:1': return [1024, 1024];
            case '16:9': return [1280, 720];
            case '9:16': return [720, 1280];
            case '4:3': return [1152, 864];
            case '3:2': return [1216, 832];
            case '21:9': return [1536, 640];
            default: return [1024, 1024];
        }
    }
}

export const muapi = new MuapiClient();
export { ProviderUnavailableError };
