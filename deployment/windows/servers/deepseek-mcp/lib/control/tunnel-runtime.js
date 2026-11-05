/** Error carrying a stable code for the manager/routes to surface. */
export class RuntimeError extends Error {
    code;
    component;
    constructor(code, message, component = 'tunnel') {
        super(message);
        this.name = 'RuntimeError';
        this.code = code;
        this.component = component;
    }
}
