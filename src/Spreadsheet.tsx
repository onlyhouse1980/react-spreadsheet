import * as React from "react";
import { connect } from "unistore/react";
import { Store } from "unistore";
import { Parser as FormulaParser } from "hot-formula-parser";

import * as Types from "./types";
import Table, { Props as TableProps } from "./Table";
import Row, { Props as RowProps } from "./Row";
import CornerIndicator, {
  Props as CornerIndicatorProps,
} from "./CornerIndicator";
import ColumnIndicator, {
  Props as ColumnIndicatorProps,
} from "./ColumnIndicator";
import RowIndicator, { Props as RowIndicatorProps } from "./RowIndicator";
import { Cell, Props as CellProps, enhance as enhanceCell } from "./Cell";
import DataViewer from "./DataViewer";
import DataEditor from "./DataEditor";
import ActiveCell from "./ActiveCell";
import Selected from "./Selected";
import Copied from "./Copied";
import { getBindingsForCell } from "./bindings";
import {
  memoizeOne,
  range,
  readTextFromClipboard,
  writeTextToClipboard,
  getComputedValue,
} from "./util";
import * as PointSet from "./point-set";
import * as Matrix from "./matrix";
import * as Actions from "./actions";
import "./Spreadsheet.css";

type DefaultValue = string | number | boolean | null;
type DefaultCellType = Types.CellBase<DefaultValue> & {
  value: DefaultValue;
};

const getValue: Types.GetValue<DefaultCellType, DefaultValue> = ({ data }) =>
  data ? data.value : null;

export type Props<CellType extends Types.CellBase<Value>, Value> = {
  formulaParser?: FormulaParser;
  columnLabels?: string[];
  ColumnIndicator?: React.ComponentType<ColumnIndicatorProps>;
  CornerIndicator?: React.ComponentType<CornerIndicatorProps>;
  rowLabels?: string[];
  RowIndicator?: React.ComponentType<RowIndicatorProps>;
  hideRowIndicators?: boolean;
  hideColumnIndicators?: boolean;
  Table?: React.ComponentType<TableProps>;
  Row?: React.ComponentType<RowProps>;
  Cell?: React.ComponentType<CellProps<CellType, Value>>;
  DataViewer?: Types.DataViewer<CellType, Value>;
  DataEditor?: Types.DataEditor<CellType, Value>;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  getValue?: Types.GetValue<CellType, Value>;
  getBindingsForCell?: Types.getBindingsForCell<CellType>;
  store: Store<Types.StoreState<CellType, Value>>;
};

type Handlers = {
  cut: () => void;
  copy: () => void;
  paste: (text: string) => void;
  setDragging: (arg0: boolean) => void;
  onKeyDownAction: (syntheticKeyboardEvent: React.KeyboardEvent) => void;
  onKeyPress: (syntheticKeyboardEvent: React.KeyboardEvent) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
};

type State = {
  rows: number;
  columns: number;
  mode: Types.Mode;
};

class Spreadsheet<
  Value,
  CellType extends Types.CellBase<Value>
> extends React.PureComponent<Props<CellType, Value> & State & Handlers> {
  static defaultProps = {
    Table,
    Row,
    Cell,
    CornerIndicator,
    ColumnIndicator,
    RowIndicator,
    DataViewer,
    DataEditor,
    getValue,
    getBindingsForCell,
  };

  formulaParser = this.props.formulaParser || new FormulaParser();

  clip = (event: ClipboardEvent) => {
    const { store, getValue } = this.props;
    const { data, selected } = store.getState();
    const startPoint = PointSet.min(selected);
    const endPoint = PointSet.max(selected);
    const slicedMatrix = Matrix.slice(startPoint, endPoint, data);
    const valueMatrix = Matrix.map((value, point) => {
      // Slice makes non-existing cells undefined, empty cells are classically
      // translated to an empty string in join()
      if (value === undefined) {
        return "";
      }
      return getValue({ ...point, data: value });
    }, slicedMatrix);
    const csv = Matrix.join(valueMatrix);
    writeTextToClipboard(event, csv);
  };

  isFocused(): boolean {
    const { activeElement } = document;

    return this.props.mode === "view" && this.root
      ? this.root === activeElement || this.root.contains(activeElement)
      : false;
  }

  handleCopy = (event: ClipboardEvent) => {
    if (this.isFocused()) {
      event.preventDefault();
      event.stopPropagation();
      this.clip(event);
      this.props.copy();
    }
  };

  handlePaste = async (event: ClipboardEvent) => {
    if (this.props.mode === "view" && this.isFocused()) {
      event.preventDefault();
      event.stopPropagation();
      if (event.clipboardData) {
        const text = readTextFromClipboard(event);
        this.props.paste(text);
      }
    }
  };

  handleCut = (event: ClipboardEvent) => {
    if (this.isFocused()) {
      event.preventDefault();
      event.stopPropagation();
      this.clip(event);
      this.props.cut();
    }
  };

  componentWillUnmount() {
    document.removeEventListener("cut", this.handleCut);
    document.removeEventListener("copy", this.handleCopy);
    document.removeEventListener("paste", this.handlePaste);
  }

  componentDidMount() {
    const { store, getValue } = this.props;
    document.addEventListener("cut", this.handleCut);
    document.addEventListener("copy", this.handleCopy);
    document.addEventListener("paste", this.handlePaste);
    this.formulaParser.on("callCellValue", (cellCoord, done) => {
      let value;
      /** @todo More sound error, or at least document */
      try {
        const cell = Matrix.get(
          cellCoord.row.index,
          cellCoord.column.index,
          store.getState().data
        );
        value = getComputedValue<CellType, Value>({
          getValue,
          cell,
          column: cellCoord.column.index,
          row: cellCoord.row.index,
          formulaParser: this.formulaParser,
        });
      } catch (error) {
        console.error(error);
      } finally {
        done(value);
      }
    });
    this.formulaParser.on(
      "callRangeValue",
      (startCellCoord, endCellCoord, done) => {
        const startPoint = {
          row: startCellCoord.row.index,
          column: startCellCoord.column.index,
        };
        const endPoint = {
          row: endCellCoord.row.index,
          column: endCellCoord.column.index,
        };
        const values = Matrix.toArray(
          Matrix.slice(startPoint, endPoint, store.getState().data),
          (cell, coords) =>
            getComputedValue<CellType, Value>({
              ...coords,
              getValue,
              cell,
              formulaParser: this.formulaParser,
            })
        );

        done(values);
      }
    );
  }

  handleKeyDown = (event) => {
    const { store, onKeyDown, onKeyDownAction } = this.props;
    if (onKeyDown) {
      onKeyDown(event);
    }
    // Do not use event in case preventDefault() was called inside onKeyDown
    if (!event.defaultPrevented) {
      // Only disable default behavior if an handler exist
      if (Actions.getKeyDownHandler(store.getState(), event)) {
        event.nativeEvent.preventDefault();
      }
      onKeyDownAction(event);
    }
  };

  handleMouseUp = () => {
    this.props.onDragEnd();
    document.removeEventListener("mouseup", this.handleMouseUp);
  };

  handleMouseMove = (event) => {
    if (!this.props.store.getState().dragging && event.buttons === 1) {
      this.props.onDragStart();
      document.addEventListener("mouseup", this.handleMouseUp);
    }
  };

  root: HTMLDivElement | null;

  handleRoot = (root: HTMLDivElement | null) => {
    this.root = root;
  };

  /**
   * The component inside the Cell prop is automatically enhanced with the enhance()
   * function inside Cell.js. This method is a small wrapper which memoizes the application
   * of enhance() to the user-provided Cell prop, in order to avoid creating new component
   * types on every re-render.
   */
  getCellComponent = memoizeOne(enhanceCell);

  render() {
    const {
      Table,
      Row,
      CornerIndicator,
      columnLabels,
      rowLabels,
      DataEditor,
      DataViewer,
      getValue,
      rows,
      columns,
      onKeyPress,
      getBindingsForCell,
      hideColumnIndicators,
      hideRowIndicators,
    } = this.props;

    // @ts-ignore
    const Cell = this.getCellComponent(this.props.Cell);

    return (
      <div
        ref={this.handleRoot}
        className="Spreadsheet"
        onKeyPress={onKeyPress}
        onKeyDown={this.handleKeyDown}
        onMouseMove={this.handleMouseMove}
      >
        <Table columns={columns} hideColumnIndicators={hideColumnIndicators}>
          <Row>
            {!hideRowIndicators && !hideColumnIndicators && <CornerIndicator />}
            {!hideColumnIndicators &&
              range(columns).map((columnNumber) =>
                columnLabels ? (
                  <ColumnIndicator
                    key={columnNumber}
                    column={columnNumber}
                    label={
                      columnNumber in columnLabels
                        ? columnLabels[columnNumber]
                        : null
                    }
                  />
                ) : (
                  <ColumnIndicator key={columnNumber} column={columnNumber} />
                )
              )}
          </Row>
          {range(rows).map((rowNumber) => (
            <Row key={rowNumber}>
              {!hideRowIndicators &&
                (rowLabels ? (
                  <RowIndicator
                    key={rowNumber}
                    row={rowNumber}
                    label={rowNumber in rowLabels ? rowLabels[rowNumber] : null}
                  />
                ) : (
                  <RowIndicator key={rowNumber} row={rowNumber} />
                ))}
              {range(columns).map((columnNumber) => (
                // @ts-ignore
                <Cell
                  key={columnNumber}
                  row={rowNumber}
                  column={columnNumber}
                  DataViewer={DataViewer}
                  getValue={getValue}
                  formulaParser={this.formulaParser}
                />
              ))}
            </Row>
          ))}
        </Table>
        <ActiveCell
          // @ts-ignore
          DataEditor={DataEditor}
          getValue={getValue}
          getBindingsForCell={getBindingsForCell}
        />
        <Selected />
        <Copied />
      </div>
    );
  }
}

const mapStateToProps = (
  { data, mode }: Types.StoreState<unknown, unknown>,
  { columnLabels }: Props<unknown, unknown>
): State => {
  const { columns, rows } = Matrix.getSize(data);
  return {
    mode,
    rows,
    columns: columnLabels ? Math.max(columns, columnLabels.length) : columns,
  };
};

export default connect(mapStateToProps, {
  copy: Actions.copy,
  cut: Actions.cut,
  paste: Actions.paste,
  onKeyDownAction: Actions.keyDown,
  onKeyPress: Actions.keyPress,
  onDragStart: Actions.dragStart,
  onDragEnd: Actions.dragEnd,
  // @ts-ignore
})(Spreadsheet);
