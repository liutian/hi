import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';

@NgModule({
  imports: [
    HttpClientModule,
    FormsModule,
    CommonModule
  ],
  exports: [
    HttpClientModule,
    FormsModule,
    CommonModule,
  ],
  declarations: []
})
export class ShareModule { }
