import { ImgConverterComponent, createIcoFromPng, FileItem } from './img-converter.component';

describe('ImgConverterComponent and createIcoFromPng', () => {

  describe('createIcoFromPng', () => {
    it('creates a valid 6-byte ICO header and 16-byte directory entry', () => {
      const dummyPng = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01]);
      const icoBytes = createIcoFromPng(dummyPng, 32, 32);

      expect(icoBytes.length).toBe(6 + 16 + dummyPng.length);

      const view = new DataView(icoBytes.buffer, icoBytes.byteOffset, icoBytes.byteLength);

      // Header
      expect(view.getUint16(0, true)).toBe(0); // Reserved
      expect(view.getUint16(2, true)).toBe(1); // 1 = ICO
      expect(view.getUint16(4, true)).toBe(1); // 1 image count

      // Directory Entry
      expect(view.getUint8(6)).toBe(32); // width
      expect(view.getUint8(7)).toBe(32); // height
      expect(view.getUint8(8)).toBe(0);  // palette
      expect(view.getUint8(9)).toBe(0);  // reserved
      expect(view.getUint16(10, true)).toBe(1);  // color planes
      expect(view.getUint16(12, true)).toBe(32); // 32 bits per pixel
      expect(view.getUint32(14, true)).toBe(dummyPng.length); // byte size
      expect(view.getUint32(18, true)).toBe(22); // offset 22

      // Image data
      expect(Array.from(icoBytes.slice(22))).toEqual(Array.from(dummyPng));
    });

    it('sets width and height to 0 when dimensions are 256 (ICO format specification)', () => {
      const dummyPng = new Uint8Array([1, 2, 3, 4]);
      const icoBytes = createIcoFromPng(dummyPng, 256, 256);
      const view = new DataView(icoBytes.buffer, icoBytes.byteOffset, icoBytes.byteLength);

      expect(view.getUint8(6)).toBe(0); // 0 represents 256 width in ICO
      expect(view.getUint8(7)).toBe(0); // 0 represents 256 height in ICO
    });
  });

  describe('ImgConverterComponent methods', () => {
    let component: ImgConverterComponent;

    beforeEach(() => {
      component = new ImgConverterComponent();
    });

    it('identifies source formats correctly', () => {
      const makeItem = (name: string, type: string): FileItem => ({
        id: 1,
        file: new File([], name, { type }),
        status: 'pending',
      });

      expect(component.sourceFormat(makeItem('test.png', 'image/png'))).toBe('PNG');
      expect(component.sourceFormat(makeItem('photo.jpg', 'image/jpeg'))).toBe('JPG');
      expect(component.sourceFormat(makeItem('graphic.webp', 'image/webp'))).toBe('WebP');
      expect(component.sourceFormat(makeItem('icon.ico', 'image/x-icon'))).toBe('ICO');
    });

    it('manages file list additions and removals', () => {
      const file1 = new File(['a'], 'one.png', { type: 'image/png' });
      const file2 = new File(['b'], 'two.jpg', { type: 'image/jpeg' });

      component.addFiles([file1, file2]);
      expect(component.files().length).toBe(2);
      expect(component.pendingCount()).toBe(2);
      expect(component.doneCount()).toBe(0);

      const firstId = component.files()[0].id;
      component.removeFile(firstId);
      expect(component.files().length).toBe(1);
      expect(component.files()[0].file.name).toBe('two.jpg');
    });

    it('converts a small PNG to ICO without errors', async () => {
      // 1x1 transparent PNG bytes
      const png1x1Base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const binaryString = atob(png1x1Base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const file = new File([bytes], 'sample.png', { type: 'image/png' });
      const item: FileItem = {
        id: 99,
        file,
        status: 'pending',
      };

      const resultBlob = await component.convertImage(item, 'ICO', 90);
      expect(resultBlob).toBeTruthy();
      expect(resultBlob.type).toBe('image/x-icon');
      expect(resultBlob.size).toBeGreaterThan(22);

      // Verify header of converted blob
      const arrayBuf = await resultBlob.arrayBuffer();
      const view = new DataView(arrayBuf);
      expect(view.getUint16(0, true)).toBe(0);
      expect(view.getUint16(2, true)).toBe(1); // ICO type
      expect(view.getUint16(4, true)).toBe(1); // 1 image
    });
  });
});
