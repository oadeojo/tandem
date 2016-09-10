import { inject, Observable, IExpression } from "tandem-common";
import { HTMLFile } from "tandem-html-extension/models";
import { MimeTypes } from "tandem-html-extension/constants";
import { DocumentFile } from "tandem-front-end/models";
import { EntityFactoryDependency, Dependencies } from "tandem-common/dependencies";
import { CSSRootEntity, parseCSS, CSSRootExpression } from "tandem-html-extension/ast";
import { FileFactoryDependency, IInjectable, Injector } from "tandem-common/dependencies";

export class CSSFile extends DocumentFile<CSSRootEntity> implements IInjectable {
  public owner: HTMLFile;
  readonly type: string = MimeTypes.CSS;
  protected createEntity(ast: CSSRootExpression) {
    return new CSSRootEntity(ast);
  }
  createExpressionLoader(): any {
    return null;
  }
}

export const cssFileDependency = new FileFactoryDependency(MimeTypes.CSS, CSSFile);