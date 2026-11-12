import { describe, expect, it } from 'vitest';
import { extractPythonFiles } from '../src/index.js';

type Files = Record<string, string>;

/** 提取一组文件，返回 qualified_name（加文件路径前缀以区分同名类）→ modelKind */
async function models(files: Files): Promise<Record<string, string | null>> {
  const sources = Object.entries(files).map(([path, source]) => ({ path, source, isTest: false, isGenerated: false }));
  const result = await extractPythonFiles(sources);
  const out: Record<string, string | null> = {};
  for (const f of result.files) for (const s of f.symbols) if (s.kind === 'class') out[`${f.path}:${s.qualifiedName}`] = s.modelKind;
  return out;
}

describe('data model recognition', () => {
  it('recognizes framework base classes', async () => {
    const r = await models({
      'm.py': [
        'import typing',
        'from typing import NamedTuple, TypedDict',
        'import pydantic',
        'from pydantic import BaseModel, RootModel',
        'from sqlmodel import SQLModel, Field',
        'from django.db import models',
        'class A(BaseModel): pass',
        'class B(pydantic.BaseModel): pass',
        'class C(RootModel[list[int]]): pass',
        'class D(SQLModel, table=True): pass',
        'class E(models.Model):',
        '    class Meta: pass',
        'class F(TypedDict, total=False): pass',
        'class G(NamedTuple): pass',
        'class H(typing.TypedDict): pass',
      ].join('\n'),
    });
    expect(r).toMatchObject({
      'm.py:A': 'pydantic', 'm.py:B': 'pydantic', 'm.py:C': 'pydantic', 'm.py:D': 'sqlmodel', 'm.py:E': 'django',
      'm.py:E.Meta': null, 'm.py:F': 'typeddict', 'm.py:G': 'namedtuple', 'm.py:H': 'typeddict',
    });
  });

  it('recognizes dataclass and attrs decorators', async () => {
    const r = await models({
      'm.py': [
        'import dataclasses',
        'from dataclasses import dataclass',
        'import attr',
        'from attrs import define, frozen',
        '@dataclass',
        'class A: pass',
        '@dataclass(frozen=True)',
        'class B: pass',
        '@dataclasses.dataclass',
        'class C: pass',
        '@define',
        'class D: pass',
        '@attr.s(auto_attribs=True)',
        'class E: pass',
        '@frozen',
        'class F: pass',
      ].join('\n'),
    });
    expect(r).toMatchObject({ 'm.py:A': 'dataclass', 'm.py:B': 'dataclass', 'm.py:C': 'dataclass', 'm.py:D': 'attrs', 'm.py:E': 'attrs', 'm.py:F': 'attrs' });
  });

  it('treats SQLAlchemy declarative bases as bases only; their subclasses are models', async () => {
    const r = await models({
      'db.py': [
        'from sqlalchemy.orm import DeclarativeBase, declarative_base',
        'from flask_sqlalchemy import SQLAlchemy',
        'class Base(DeclarativeBase): pass',
        'Legacy = declarative_base()',
        'db = SQLAlchemy()',
        'class User(Base): pass',
        'class Old(Legacy): pass',
        'class Post(db.Model): pass',
      ].join('\n'),
      'other.py': ['from db import Base, db', 'class Tag(Base): pass', 'class Item(db.Model): pass'].join('\n'),
    });
    expect(r).toMatchObject({
      'db.py:Base': null, 'db.py:User': 'sqlalchemy', 'db.py:Old': 'sqlalchemy', 'db.py:Post': 'sqlalchemy',
      'other.py:Tag': 'sqlalchemy', 'other.py:Item': 'sqlalchemy',
    });
  });

  it('propagates through subclasses in the same file and across files, following package re-exports', async () => {
    const r = await models({
      'app/schemas/base.py': 'from pydantic import BaseModel\nclass UserBase(BaseModel): pass\nclass UserCreate(UserBase): pass\n',
      'app/schemas/__init__.py': 'from .base import UserBase\n',
      'app/api/users.py': 'from app.schemas import UserBase\nfrom app import schemas\nclass UserOut(UserBase): pass\nclass UserPatch(schemas.UserBase): pass\n',
      'app/api/deep.py': 'from app.api.users import UserOut\nclass Deeper(UserOut): pass\n',
    });
    expect(r).toMatchObject({
      'app/schemas/base.py:UserBase': 'pydantic', 'app/schemas/base.py:UserCreate': 'pydantic',
      'app/api/users.py:UserOut': 'pydantic', 'app/api/users.py:UserPatch': 'pydantic', 'app/api/deep.py:Deeper': 'pydantic',
    });
  });

  it('uses a unique same-named class for names without any import (star imports)', async () => {
    const r = await models({
      'a.py': 'from pydantic import BaseModel\nclass Shared(BaseModel): pass\n',
      'b.py': 'from a import *\nclass Child(Shared): pass\n',
    });
    expect(r['b.py:Child']).toBe('pydantic');
  });

  it('does not mark ordinary classes, enums, exceptions or a project class that merely shadows a framework name', async () => {
    const r = await models({
      'own.py': 'class BaseModel:\n    pass\n',
      'm.py': [
        'from enum import Enum',
        'from own import BaseModel',
        'class Plain: pass',
        'class Color(str, Enum): pass',
        'class Oops(Exception): pass',
        'class Fake(BaseModel): pass',
        'class Mixin(object): pass',
        'class Net(keras.Model): pass',
        '@some.decorator',
        'class Decorated: pass',
      ].join('\n'),
    });
    expect(r).toMatchObject({
      'own.py:BaseModel': null, 'm.py:Plain': null, 'm.py:Color': null, 'm.py:Oops': null, 'm.py:Fake': null,
      'm.py:Mixin': null, 'm.py:Net': null, 'm.py:Decorated': null,
    });
  });

  it('lets a class override a framework name it imports, and survives inheritance cycles', async () => {
    const r = await models({
      'm.py': 'from pydantic import BaseModel\nclass BaseModel(BaseModel): pass\nclass X(BaseModel): pass\n',
      'c.py': 'class P(Q): pass\nclass Q(P): pass\n',
    });
    expect(r).toMatchObject({ 'm.py:BaseModel': 'pydantic', 'm.py:X': 'pydantic', 'c.py:P': null, 'c.py:Q': null });
  });
});
